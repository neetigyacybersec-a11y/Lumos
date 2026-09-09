import { describe, it, expect, vi } from 'vitest';
import { planChunkEmbeddings, mergeEdges } from '../src/indexing/stages';
import { RelationEdge } from '../src/relationStore';



function edge(target: string, relationType: RelationEdge['relationType'], confidence = 0.9): RelationEdge {
    return { source: 'src.md', target, relationType, confidence, evidence: '' };
}

describe('planChunkEmbeddings', () => {
    it('reuses stored embeddings for unchanged chunks and embeds only new/changed ones', async () => {
        const { hashString } = await import('../src/utils');
        const t1 = 'unchanged one';
        const t2 = 'also unchanged two';
        const t3 = 'brand new paragraph';
        const embed = vi.fn(async (text: string) => [text.length]);
        const [h1, h2] = await Promise.all([hashString(t1), hashString(t2)]);
        const plan = await planChunkEmbeddings(
            'a.md',
            [t1, t2, t3],
            [
                { chunkHash: h1, embedding: [11] },
                { chunkHash: h2, embedding: [22] },
            ],
            await hashString('filehash'),
            embed
        );

        expect(embed).toHaveBeenCalledTimes(1);
        expect(plan.changedChunkTexts).toEqual([t3]);
        expect(plan.vectorChunks).toHaveLength(3);
        // reused embedding survives verbatim on the matching chunk
        expect(plan.vectorChunks[0].embedding).toEqual([11]);
        expect(plan.vectorChunks[1].embedding).toEqual([22]);
        expect(plan.vectorChunks[2].embedding).toEqual([t3.length]);
        expect(plan.vectorChunks[0].chunkHash).toBe(h1);
    });

    it('embeds everything when there is no previous state (fresh file)', async () => {
        const embed = vi.fn(async (text: string) => [text.length]);
        const plan = await planChunkEmbeddings('b.md', ['x', 'y'], [], 'hash', embed);
        expect(embed).toHaveBeenCalledTimes(2);
        expect(plan.changedChunkTexts).toHaveLength(2);
    });
});

describe('mergeEdges', () => {
    it('new edges supersede old ones per (target, relationType) and keep the rest', () => {
        const existing = [
            edge('a.md', 'prerequisite'),
            edge('b.md', 'extends'),
            edge('c.md', 'thematic-only'),
        ];
        const scored = [
            edge('a.md', 'contradicts'),   // same target, new type -> both survive
            edge('c.md', 'thematic-only'), // exact supersede
            edge('d.md', 'follows-up'),    // brand new
        ];

        const merged = mergeEdges(existing, scored);

        expect(merged.filter(e => e.target === 'a.md').map(e => e.relationType).sort())
            .toEqual(['contradicts', 'prerequisite']);
        expect(merged.filter(e => e.target === 'b.md')).toHaveLength(1); // untouched kept
        expect(merged.filter(e => e.target === 'c.md')).toHaveLength(1); // superseded, not duplicated
        expect(merged.filter(e => e.target === 'd.md')).toHaveLength(1);

        // kept edges come before fresh ones
        expect(merged.findIndex(e => e.target === 'b.md'))
            .toBeLessThan(merged.findIndex(e => e.target === 'd.md'));
    });
});
