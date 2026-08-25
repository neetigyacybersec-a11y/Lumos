export interface LexicalSearchResult {
    filePath: string;
    text: string;
    score: number;
}

interface DocEntry {
    docId: number;
    filePath: string;
    text: string;
    length: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * Tokenizes text for BM25. Lowercased alphanumeric runs keep identifiers
 * matchable ("CVE-2024-3094" -> ["cve", "2024", "3094"]); CJK runs become
 * overlapping bigrams since they have no whitespace boundaries.
 */
export function tokenizeText(text: string): string[] {
    if (!text) return [];
    const tokens: string[] = [];
    const latin = /[a-z0-9]+/g;
    const lower = text.toLowerCase();
    let m: RegExpExecArray | null;
    while ((m = latin.exec(lower)) !== null) {
        tokens.push(m[0]);
    }
    const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
    while ((m = cjk.exec(text)) !== null) {
        const run = m[0];
        if (run.length === 1) {
            tokens.push(run);
        } else {
            for (let i = 0; i < run.length - 1; i++) {
                tokens.push(run.slice(i, i + 2));
            }
        }
    }
    return tokens;
}

/**
 * Self-contained BM25 (Okapi, k1=1.2 b=0.75) inverted index over chunk texts.
 * Mirrors VectorStore mutations so it never drifts from the vector corpus.
 */
export class LexicalIndex {
    private postings: Map<string, Map<number, number>> = new Map(); // term -> docId -> tf
    private docs: Map<number, DocEntry> = new Map();
    private docsByPath: Map<string, Set<number>> = new Map();
    private nextDocId = 0;
    private totalLength = 0;

    get docCount(): number {
        return this.docs.size;
    }

    upsert(filePath: string, chunks: { text: string }[]) {
        this.delete(filePath);
        for (const chunk of chunks) {
            this.add(filePath, chunk.text);
        }
    }

    delete(filePath: string) {
        const ids = this.docsByPath.get(filePath);
        if (!ids) return;
        for (const docId of ids) {
            const doc = this.docs.get(docId);
            if (!doc) continue;
            this.totalLength -= doc.length;
            this.docs.delete(docId);
            for (const [term, posting] of this.postings) {
                posting.delete(docId);
                if (posting.size === 0) this.postings.delete(term);
            }
        }
        this.docsByPath.delete(filePath);
    }

    renameFile(oldPath: string, newPath: string) {
        const ids = this.docsByPath.get(oldPath);
        if (!ids) return;
        this.docsByPath.delete(oldPath);
        const moved = new Set<number>();
        for (const docId of ids) {
            const doc = this.docs.get(docId);
            if (!doc) continue;
            doc.filePath = newPath;
            moved.add(docId);
        }
        this.docsByPath.set(newPath, moved);
    }

    clear() {
        this.postings.clear();
        this.docs.clear();
        this.docsByPath.clear();
        this.totalLength = 0;
        // Keep nextDocId monotonic so stale references can't collide.
    }

    rebuild(chunks: { filePath: string; text: string; embedding: number[] }[]) {
        this.clear();
        for (const chunk of chunks) {
            if (chunk.embedding.length === 0) continue; // skip empty/failed markers
            this.add(chunk.filePath, chunk.text);
        }
    }

    search(query: string, k: number = 50): LexicalSearchResult[] {
        const terms = tokenizeText(query);
        if (terms.length === 0 || this.docs.size === 0) return [];

        const avgLen = this.totalLength / this.docCount || 1;
        const scores = new Map<number, number>();
        const seen = new Set<string>();

        for (const term of terms) {
            if (seen.has(term)) continue;
            seen.add(term);
            const posting = this.postings.get(term);
            if (!posting) continue;
            const df = posting.size;
            const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
            for (const [docId, tf] of posting) {
                const doc = this.docs.get(docId);
                if (!doc) continue;
                const norm = (tf * (K1 + 1)) /
                    (tf + K1 * (1 - B + B * (doc.length / avgLen)));
                scores.set(docId, (scores.get(docId) ?? 0) + idf * norm);
            }
        }

        // Collapse to per-file best chunk, then rank.
        const bestByPath = new Map<string, { text: string; score: number }>();
        for (const [docId, score] of scores) {
            const doc = this.docs.get(docId)!;
            const existing = bestByPath.get(doc.filePath);
            if (!existing || score > existing.score) {
                bestByPath.set(doc.filePath, { text: doc.text, score });
            }
        }

        return [...bestByPath.entries()]
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, k)
            .map(([filePath, v]) => ({ filePath, text: v.text, score: v.score }));
    }

    private add(filePath: string, text: string) {
        const tokens = tokenizeText(text);
        if (tokens.length === 0) return;

        const docId = this.nextDocId++;
        this.docs.set(docId, { docId, filePath, text, length: tokens.length });
        this.totalLength += tokens.length;

        let ids = this.docsByPath.get(filePath);
        if (!ids) {
            ids = new Set();
            this.docsByPath.set(filePath, ids);
        }
        ids.add(docId);

        const tfByTerm = new Map<string, number>();
        for (const term of tokens) {
            tfByTerm.set(term, (tfByTerm.get(term) ?? 0) + 1);
        }
        for (const [term, tf] of tfByTerm) {
            let posting = this.postings.get(term);
            if (!posting) {
                posting = new Map();
                this.postings.set(term, posting);
            }
            posting.set(docId, tf);
        }
    }
}
