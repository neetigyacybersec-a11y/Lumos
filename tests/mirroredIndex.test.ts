import { describe, it, expect } from 'vitest';
import { MirroredIndex, MutationSource } from '../src/search/mirroredIndex';
import { VectorChunk } from '../src/vectorStore';

function chunk(filePath: string, text: string, embedding: number[]): VectorChunk {
    return { id: `${filePath}#0`, filePath, text, embedding };
}

function makeSource(vectors: VectorChunk[]): MutationSource & { onMutation: NonNullable<MutationSource['onMutation']> } {
    const source: MutationSource & { onMutation: NonNullable<MutationSource['onMutation']> } = {
        vectors,
        onMutation: undefined as any,
    };
    return source;
}

describe('MirroredIndex', () => {
    it('seeds only chunks with real embeddings (skips marker rows)', () => {
        const source = makeSource([
            chunk('a.md', 'alpha', [0.1]),
            chunk('b.md', 'beta', []),
        ]);
        const mirror = new MirroredIndex();
        mirror.attach(source);

        expect(mirror.lexical.search('alpha')).toHaveLength(1);
        expect(mirror.lexical.search('beta')).toHaveLength(0);
        expect(mirror.lexical.docCount).toBe(1);
    });

    it('upsert ignores empty-embedding mutations', () => {
        const source = makeSource([]);
        const mirror = new MirroredIndex();
        mirror.attach(source);

        source.onMutation('upsert', 'a.md', undefined, [chunk('a.md', 'alpha', [0.1])]);
        source.onMutation('upsert', 'b.md', undefined, [chunk('b.md', 'beta', [])]);

        expect(mirror.lexical.search('alpha')).toHaveLength(1);
        expect(mirror.lexical.search('beta')).toHaveLength(0);
    });

    it('forwards delete, rename and clear', () => {
        const source = makeSource([
            chunk('a.md', 'alpha', [0.1]),
            chunk('b.md', 'beta', [0.1]),
        ]);
        const mirror = new MirroredIndex();
        mirror.attach(source);

        source.onMutation('delete', 'a.md');
        expect(mirror.lexical.search('alpha')).toHaveLength(0);
        expect(mirror.lexical.search('beta')).toHaveLength(1);

        source.onMutation('rename', 'c.md', 'b.md');
        const results = mirror.lexical.search('beta');
        expect(results[0].filePath).toBe('c.md');

        source.onMutation('clear');
        expect(mirror.lexical.search('beta')).toHaveLength(0);
        expect(mirror.lexical.docCount).toBe(0);
    });
});