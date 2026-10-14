import { describe, it, expect } from 'vitest';
import { sanitizeRelations, repairAiRelationsBlock } from '../src/backlinker';

describe('sanitizeRelations', () => {
    it('drops embeds, tags, numeric/empty values, and non-strings', () => {
        const out = sanitizeRelations([
            '[[Splunk]]',
            '![[Pasted image 20260824074459]]',
            '#tag',
            '123',
            '   ',
            42,
            null,
        ]);
        expect(out).toEqual(['[[Splunk]]']);
    });

    it('normalizes bare basenames to wikilinks and dedupes case-insensitively', () => {
        const out = sanitizeRelations(['Note', '[[note]]', 'Other', 'Other']);
        expect(out).toEqual(['[[Note]]', '[[Other]]']);
    });
});

describe('repairAiRelationsBlock', () => {
    it('rewrites a corrupt ai_relations block as quoted values, preserving other keys', () => {
        const data =
            '---\nai_relations:\n  - "[[Splunk]]"\n  - ![[Pasted image 20260824074459]]\ntags:\n  - infra\n---\n\nbody text';
        const out = repairAiRelationsBlock(data, ['[[Pasted image 20260824183434]]']);
        expect(out).toBe(
            '---\nai_relations:\n  - "[[Splunk]]"\n  - "[[Pasted image 20260824183434]]"\ntags:\n  - infra\n---\n\nbody text'
        );
    });

    it('appends new links to an existing clean block', () => {
        const data = '---\nai_relations:\n  - "[[Splunk]]"\n---\n\nbody';
        const out = repairAiRelationsBlock(data, ['[[NMAP]]']);
        expect(out).toBe('---\nai_relations:\n  - "[[Splunk]]"\n  - "[[NMAP]]"\n---\n\nbody');
    });

    it('leaves the file untouched when there is no ai_relations key', () => {
        const data = '---\ntags:\n  - foo\n---\n\nbody';
        expect(repairAiRelationsBlock(data, ['[[X]]'])).toBe(data);
    });

    it('leaves the file untouched when there is no frontmatter', () => {
        const data = '# just a title\nbody';
        expect(repairAiRelationsBlock(data, ['[[X]]'])).toBe(data);
    });
});