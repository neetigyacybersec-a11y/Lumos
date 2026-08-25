import { RelationEdge } from '../relationStore';
import { hashString } from '../utils';

/**
 * Pure, unit-testable stages of the indexing pipeline. Kept free of Obsidian
 * and I/O so the trickiest invariants (incremental chunk reuse, edge merging)
 * can be tested directly instead of through a full BackgroundIndexer world.
 */

export interface PlannedChunk {
    id: string;
    filePath: string;
    text: string;
    embedding: number[];
    contentHash: string;
    chunkHash: string;
}

export interface ChunkPlanResult {
    vectorChunks: PlannedChunk[];
    changedChunkTexts: string[];
}

/**
 * Builds the chunk list for a file, reusing stored embeddings for chunks
 * whose text is unchanged. Only genuinely new/changed chunks hit the embed
 * function — the invariant behind cheap partial edits.
 */
export async function planChunkEmbeddings(
    filePath: string,
    chunks: string[],
    previousChunks: { chunkHash?: string; embedding: number[] }[],
    contentHash: string,
    embed: (text: string) => Promise<number[]>
): Promise<ChunkPlanResult> {
    const reusable = new Map<string, number[]>();
    for (const prev of previousChunks) {
        if (prev.chunkHash && prev.embedding.length > 0) {
            reusable.set(prev.chunkHash, prev.embedding);
        }
    }

    const changedChunkTexts: string[] = [];
    const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
        const chunkHash = hashString(text);
        let embedding = reusable.get(chunkHash);
        if (!embedding) {
            embedding = await embed(text);
            changedChunkTexts.push(text);
        }
        return { id: `${filePath}#${i}`, filePath, text, embedding, contentHash, chunkHash };
    }));

    return { vectorChunks, changedChunkTexts };
}

/**
 * Merges freshly scored edges with edges discovered by unchanged content:
 * new edges supersede old ones per (target, relationType); everything else is
 * kept so a partial edit cannot silently drop established relations.
 */
export function mergeEdges(existing: RelationEdge[], scored: RelationEdge[]): RelationEdge[] {
    const superseded = new Set(scored.map(e => `${e.target}|${e.relationType}`));
    const kept = existing.filter(e => !superseded.has(`${e.target}|${e.relationType}`));
    return [...kept, ...scored];
}
