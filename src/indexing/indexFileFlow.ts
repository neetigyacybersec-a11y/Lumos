import { hashString } from '../utils';
import { planChunkEmbeddings } from './stages';

/**
 * The collaborators an IndexFileFlow needs to take one document through the
 * whole journey: chunk plan, embedding, retrieval, relation extraction and
 * persistence. Structurally satisfied by LumosPlugin.
 */
export interface IndexFileHost {
    vectorStore: {
        getFileHash(filePath: string): string | undefined;
        getChunks(filePath: string): { chunkHash?: string; embedding: number[] }[];
        upsert(filePath: string, chunks: any[]): Promise<void>;
        getFileCount(): number;
        /** The current model's embedding dimension, or undefined until learned. */
        dimension: number | undefined;
        /** Learn the model's embedding dimension from a fresh embedding. */
        recordDimension(dim: number): void;
    };
    embeddingPipeline: {
        chunkText(text: string): string[];
        embed(text: string): Promise<number[]>;
    };
    hybridRetriever: {
        retrieve(opts: {
            queryVector?: number[];
            lexicalQuery?: string;
            topK: number;
            excludeFilePath?: string;
            skipRerank?: boolean;
        }): Promise<{ filePath: string; text: string; similarity: number }[]>;
    };
    relationExtractor: {
        constructPrompt(sourcePath: string, sourceText: string, candidates: { path: string; text: string }[]): string;
        extractRelations(prompt: string, sourcePath: string): Promise<{ edges: any[]; profileInsights: string | null }>;
    };
    relationStore: {
        getEdgesForPath(path: string): any[];
        upsertEdges(sourcePath: string, edges: any[], skipSave?: boolean): Promise<void>;
    };
}

export interface ExtractResult {
    text: string;
    madeNetworkCall: boolean;
    /** The document is gone (e.g. deleted while queued): skip entirely, no marker. */
    absent?: boolean;
}

/**
 * Per-document-type variance in the index pipeline. A vault note and a
 * calendar event share the journey but differ in where the text comes from,
 * how edges are scored and which side effects fire after a successful index.
 */
export interface IndexInput {
    /** Stable storage key — a vault path or a virtual id (e.g. gcal://...). */
    readonly path: string;
    /** Produce the clean text to index. Blank text persists an empty marker. */
    extractText(): Promise<ExtractResult>;
    /** Select the excerpt fed to the lexical query and the LLM prompt. */
    promptSource(text: string, changedChunkTexts: string[], isPartialUpdate: boolean): string;
    /** Score the extracted edges per document-type policy. */
    score(edges: any[], similar: { filePath: string; text: string; similarity: number }[]): Promise<any[]>;
    /** On a partial re-index, fold new edges into the existing ones. */
    mergeOnPartial(existing: any[], scored: any[]): any[];
    /** Side effects once edges are persisted: profile insights, backlinks, … */
    afterPersist(edges: any[], profileInsights: string | null): Promise<void>;
    /** No relations were produced (no anchor, or nothing similar found). */
    onNoRelations(text: string, hadAnchor: boolean): Promise<void>;
}

export interface IndexFileResult {
    madeNetworkCall: boolean;
}

const SIMILAR_TOP_K = 3;
const LEXICAL_QUERY_MAX = 4000;

/**
 * The per-document indexing journey shared by every doc source. Owns the
 * incremental chunk plan, candidate retrieval, relation extraction, scoring
 * and persistence behind one small surface; the only per-type variance lives
 * in the IndexInput strategy.
 */
export class IndexFileFlow {
    constructor(private readonly host: IndexFileHost) {}

    async index(input: IndexInput): Promise<IndexFileResult> {
        let madeNetworkCall = false;

        const extracted = await input.extractText();
        madeNetworkCall = madeNetworkCall || extracted.madeNetworkCall;
        if (extracted.absent) {
            return { madeNetworkCall };
        }
        if (!extracted.text || extracted.text.trim() === '') {
            // Mark as indexed with 0 chunks so we don't process it on every startup.
            await this.host.vectorStore.upsert(input.path, []);
            return { madeNetworkCall };
        }
        const text = extracted.text;

        const contentHash = await hashString(text);
        if (this.host.vectorStore.getFileHash(input.path) === contentHash) {
            return { madeNetworkCall };
        }

        // Embed only new/changed chunks; reuse stored vectors for chunks
        // whose text is unchanged (#incremental-edit).
        const previousChunks = this.host.vectorStore.getChunks(input.path);
        const isPartialUpdate = previousChunks.length > 0;
        const chunks = this.host.embeddingPipeline.chunkText(text);
        const plan = await planChunkEmbeddings(input.path, chunks, previousChunks, contentHash, async (chunkText) => {
            const vec = await this.host.embeddingPipeline.embed(chunkText);
            this.host.vectorStore.recordDimension(vec.length);
            return vec;
        }, this.host.vectorStore.dimension);
        if (plan.changedChunkTexts.length > 0) madeNetworkCall = true;

        const firstEmbedding: number[] | null = plan.vectorChunks.length > 0 ? plan.vectorChunks[0].embedding : null;
        await this.host.vectorStore.upsert(input.path, plan.vectorChunks);

        // Extract relations only if there is an anchor to compare against.
        if (firstEmbedding && this.host.vectorStore.getFileCount() > 1) {
            // Hybrid candidate selection: dense anchor embedding plus a BM25
            // query over the new/changed text. Reranking is a search feature
            // only — never burn model inference per indexed file.
            const sourceText = input.promptSource(text, plan.changedChunkTexts, isPartialUpdate);
            const similar = await this.host.hybridRetriever.retrieve({
                queryVector: firstEmbedding,
                lexicalQuery: sourceText.slice(0, LEXICAL_QUERY_MAX),
                topK: SIMILAR_TOP_K,
                excludeFilePath: input.path,
                skipRerank: true,
            });

            if (similar.length > 0) {
                const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
                const prompt = this.host.relationExtractor.constructPrompt(input.path, sourceText, candidates);
                const { edges, profileInsights } = await this.host.relationExtractor.extractRelations(prompt, input.path);
                madeNetworkCall = true;

                const scored = await input.score(edges, similar);

                // Keep relations discovered by unchanged chunks; the LLM only
                // re-derives those touching changed text.
                const existing = this.host.relationStore.getEdgesForPath(input.path)
                    .filter(e => e.source === input.path);
                const final = isPartialUpdate ? input.mergeOnPartial(existing, scored) : scored;

                await this.host.relationStore.upsertEdges(input.path, final, true);
                await input.afterPersist(final, profileInsights);
            } else {
                await input.onNoRelations(text, true);
            }
        } else {
            await input.onNoRelations(text, false);
        }

        return { madeNetworkCall };
    }
}