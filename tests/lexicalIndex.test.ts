import { describe, it, expect } from 'vitest';
import { LexicalIndex, tokenizeText } from '../src/search/lexicalIndex';

describe('tokenizeText', () => {
    it('lowercases and splits on non-alphanumerics', () => {
        expect(tokenizeText('Hello, World! foo_bar')).toEqual(['hello', 'world', 'foo', 'bar']);
    });

    it('keeps identifiers matchable by splitting hyphens consistently', () => {
        const doc = tokenizeText('We tracked CVE-2024-3094 today.');
        const query = tokenizeText('CVE-2024-3094');
        expect(query).toEqual(['cve', '2024', '3094']);
        for (const t of query) expect(doc).toContain(t);
    });

    it('emits CJK bigrams', () => {
        const tokens = tokenizeText('知識管理');
        expect(tokens).toEqual(['知識', '識管', '管理']);
    });

    it('returns empty for empty input', () => {
        expect(tokenizeText('')).toEqual([]);
        expect(tokenizeText('   !!! --- ')).toEqual([]);
    });
});

describe('LexicalIndex', () => {
    it('ranks documents containing rare query terms above common ones', () => {
        const idx = new LexicalIndex();
        idx.upsert('a.md', [{ text: 'the team met to discuss the roadmap and the budget' }]);
        idx.upsert('b.md', [{ text: 'kubernetes cluster autoscaling notes' }]);

        const results = idx.search('kubernetes');
        expect(results[0].filePath).toBe('b.md');
    });

    it('finds exact identifiers that dense embeddings would paraphrase away', () => {
        const idx = new LexicalIndex();
        idx.upsert('incident.md', [{ text: 'outage postmortem for CVE-2024-3094 supply chain attack' }]);
        idx.upsert('general.md', [{ text: 'thoughts on software supply chains and security generally' }]);

        const results = idx.search('CVE-2024-3094');
        expect(results[0].filePath).toBe('incident.md');
    });

    it('collapses multiple chunks per file to the best chunk', () => {
        const idx = new LexicalIndex();
        idx.upsert('multi.md', [
            { text: 'cooking recipes for pasta' },
            { text: 'kubernetes networking deep dive' },
            { text: 'gardening tips' },
        ]);
        const results = idx.search('kubernetes networking');
        expect(results).toHaveLength(1);
        expect(results[0].text).toContain('kubernetes');
    });

    it('handles incremental upsert without ghost matches', () => {
        const idx = new LexicalIndex();
        idx.upsert('a.md', [{ text: 'original content about dragons' }]);
        expect(idx.search('dragons')).toHaveLength(1);

        idx.upsert('a.md', [{ text: 'replaced with content about wizards' }]);
        expect(idx.search('dragons')).toHaveLength(0);
        expect(idx.search('wizards')).toHaveLength(1);
        expect(idx.docCount).toBe(1);
    });

    it('delete removes all traces', () => {
        const idx = new LexicalIndex();
        idx.upsert('a.md', [{ text: 'alpha beta' }, { text: 'alpha gamma' }]);
        expect(idx.docCount).toBe(2);
        idx.delete('a.md');
        expect(idx.docCount).toBe(0);
        expect(idx.search('alpha')).toHaveLength(0);
        idx.delete('a.md'); // idempotent
    });

    it('renameFile moves documents without duplicating them', () => {
        const idx = new LexicalIndex();
        idx.upsert('old.md', [{ text: 'rename me content' }]);
        idx.renameFile('old.md', 'new.md');
        expect(idx.search('rename').map((r) => r.filePath)).toEqual(['new.md']);
        idx.delete('old.md');
        expect(idx.search('rename')).toHaveLength(1);
    });

    it('skips length-0 documents but keeps the file searchable via other chunks', () => {
        const idx = new LexicalIndex();
        idx.upsert('a.md', [{ text: '' }, { text: 'real content here' }]);
        expect(idx.docCount).toBe(1);
        expect(idx.search('real')[0].filePath).toBe('a.md');
    });

    it('rebuild skips marker rows (empty embedding)', () => {
        const idx = new LexicalIndex();
        idx.rebuild([
            { filePath: 'ok.md', text: 'indexed chunk', embedding: [1] },
            { filePath: 'marker.md', text: '', embedding: [] },
            { filePath: 'marker2.md', text: 'should be skipped too', embedding: [] },
        ]);
        expect(idx.docCount).toBe(1);
        expect(idx.search('chunk')[0].filePath).toBe('ok.md');
    });

    it('clear empties everything', () => {
        const idx = new LexicalIndex();
        idx.upsert('a.md', [{ text: 'some words' }]);
        idx.clear();
        expect(idx.docCount).toBe(0);
        expect(idx.search('words')).toHaveLength(0);
    });

    it('length normalization keeps long docs from dominating short relevant ones', () => {
        const idx = new LexicalIndex();
        const filler = Array.from({ length: 400 }, (_, i) => `filler${i}`).join(' ');
        idx.upsert('short.md', [{ text: 'quantum computing explained' }]);
        idx.upsert('long.md', [{ text: `quantum mention buried inside ${filler}` }]);

        const results = idx.search('quantum computing');
        expect(results[0].filePath).toBe('short.md');
    });
});
