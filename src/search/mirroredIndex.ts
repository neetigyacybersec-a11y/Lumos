import { LexicalIndex } from './lexicalIndex';
import { VectorChunk } from '../vectorStore';

/**
 * A source of vector-corpus mutations. `VectorStore` satisfies this
 * structurally; tests can use a plain stub.
 */
export interface MutationSource {
    vectors: VectorChunk[];
    onMutation?: (
        op: 'upsert' | 'delete' | 'rename' | 'clear',
        filePath?: string,
        oldPath?: string,
        chunks?: VectorChunk[]
    ) => void;
}

/**
 * Owns the lexical (BM25) mirror of the vector corpus. Attaching to a
 * MutationSource seeds it from the current corpus and subscribes to every
 * mutation so the mirror can never drift from the vectors. Callers use
 * `.lexical` (e.g. to feed HybridRetriever) without replicating the filter
 * or the delete/rename/clear handling themselves.
 */
export class MirroredIndex {
    readonly lexical: LexicalIndex = new LexicalIndex();

    /** Seeds the mirror from the corpus and keeps it in sync from here on. */
    attach(source: MutationSource) {
        this.lexical.rebuild(
            source.vectors.filter((v) => v.embedding.length > 0)
        );
        source.onMutation = (op, filePath, oldPath, chunks) => {
            if (op === 'upsert' && filePath && chunks) {
                this.lexical.upsert(filePath, chunks.filter((c) => c.embedding.length > 0));
            } else if (op === 'delete' && filePath) {
                this.lexical.delete(filePath);
            } else if (op === 'rename' && filePath && oldPath) {
                this.lexical.renameFile(oldPath, filePath);
            } else if (op === 'clear') {
                this.lexical.clear();
            }
        };
    }
}