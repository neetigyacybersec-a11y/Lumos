import { Logger } from '../logger';
import { RetrievalHost } from '../ports';
import { LexicalIndex } from './lexicalIndex';
import { Reranker } from './reranker';

export interface RetrievalResult {
    filePath: string;
    text: string;
    similarity: number;
}

interface FusedCandidate {
    filePath: string;
    text: string;
    rrfScore: number;
}

const RRF_K = 60;

/**
 * Fuses ranked lists by reciprocal rank (Cormack et al. 2009). Rank positions
 * only — BM25 and cosine scores are never mixed directly.
 */
export function rrfFuse(lists: { filePath: string; text: string }[][], k: number = RRF_K): FusedCandidate[] {
    const byPath = new Map<string, FusedCandidate>();
    for (const list of lists) {
        for (let rank = 0; rank < list.length; rank++) {
            const item = list[rank];
            let entry = byPath.get(item.filePath);
            if (!entry) {
                // Representative chunk comes from the highest-priority leg that found it.
                entry = { filePath: item.filePath, text: item.text, rrfScore: 0 };
                byPath.set(item.filePath, entry);
            }
            entry.rrfScore += 1 / (k + rank + 1);
        }
    }
    return [...byPath.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface RetrieveOptions {
    query?: string;
    queryVector?: number[];
    lexicalQuery?: string;
    topK: number;
    candidateK?: number;
    excludeFilePath?: string;
    /** Background indexing passes true: reranking is a search-time feature. */
    skipRerank?: boolean;
}

/**
 * Hybrid retrieval: BM25 + dense vectors fused with RRF, with an optional
 * local cross-encoder rerank stage on the fused top candidates.
 */
export class HybridRetriever {
    constructor(
        private plugin: RetrievalHost,
        private lexical: LexicalIndex,
        private reranker: Reranker
    ) {}

    async retrieve(opts: RetrieveOptions): Promise<RetrievalResult[]> {
        if (!opts.queryVector && !opts.query?.trim()) return [];
        const candidateK = opts.candidateK ?? Math.max(opts.topK * 5, 50);

        const [denseList, lexicalList] = await Promise.all([
            this.denseLeg(opts, candidateK),
            this.lexicalLeg(opts, candidateK),
        ]);

        let candidates = rrfFuse([denseList, lexicalList]);
        if (opts.excludeFilePath) {
            candidates = candidates.filter((c) => c.filePath !== opts.excludeFilePath);
        }
        if (candidates.length === 0) return [];

        // Cascade: rerank the fused top-N when a model is enabled and available.
        if (!opts.skipRerank && this.plugin.settings.rerankerModel !== 'off') {
            const depth = Math.min(this.plugin.settings.rerankCandidates || 20, candidates.length);
            const toRerank = candidates.slice(0, depth);
            const scores = await this.reranker.rerank(
                opts.query ?? opts.lexicalQuery ?? '',
                toRerank.map((c) => c.text),
                this.plugin.settings.rerankerModel
            );
            if (scores) {
                return toRerank
                    .map((c, i) => ({ filePath: c.filePath, text: c.text, similarity: scores[i] }))
                    .sort((a, b) => b.similarity - a.similarity)
                    .concat(
                        candidates.slice(depth).map((c) => ({
                            filePath: c.filePath,
                            text: c.text,
                            similarity: c.rrfScore,
                        }))
                    )
                    .slice(0, opts.topK);
            }
            // Reranker unavailable -> fall through to RRF-normalized ranking.
        }

        const max = candidates[0].rrfScore || 1;
        return candidates.slice(0, opts.topK).map((c) => ({
            filePath: c.filePath,
            text: c.text,
            similarity: c.rrfScore / max,
        }));
    }

    private async denseLeg(opts: RetrieveOptions, candidateK: number): Promise<RetrievalResult[]> {
        try {
            const vec = opts.queryVector ?? (await this.plugin.embeddingPipeline.embed(opts.query!));
            const similar = await this.plugin.vectorStore.querySimilar(vec, candidateK, opts.excludeFilePath);
            return similar.map((s) => ({ filePath: s.filePath, text: s.text, similarity: s.similarity }));
        } catch (e) {
            // Dense leg down (embedding backend unreachable) — lexical still works.
            Logger.warn('[Lumos] Hybrid retrieval dense leg failed, using lexical only:', e);
            return [];
        }
    }

    private lexicalLeg(opts: RetrieveOptions, candidateK: number): RetrievalResult[] {
        if (!this.plugin.settings.enableHybridSearch) return [];
        const q = opts.lexicalQuery ?? opts.query ?? '';
        if (!q.trim()) return [];
        const results = this.lexical.search(q, candidateK);
        if (opts.excludeFilePath) {
            return results.filter((r) => r.filePath !== opts.excludeFilePath);
        }
        return results;
    }
}
