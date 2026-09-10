import { describe, it, expect, vi } from 'vitest';
import {
    extractEmbeds,
    extractOriginalLinks,
    basenameOf,
    reviewWhitelist,
    buildPayload,
    collectImageContext,
    collectRelated,
    beautifyNote,
    beautifySelection,
    BeautifyHost,
    BeautifyOptions,
} from '../src/beautify';
import { BeautifyCache } from '../src/beautifyCache';

function makeAdapter() {
    const files: Record<string, string> = {};
    return {
        async read(p: string): Promise<string> {
            if (!(p in files)) throw new Error('ENOENT');
            return files[p];
        },
        async write(p: string, d: string): Promise<void> {
            files[p] = d;
        },
        async exists(p: string): Promise<boolean> {
            return p in files;
        },
        async remove(p: string): Promise<void> {
            delete files[p];
        },
        async rename(o: string, n: string): Promise<void> {
            files[n] = files[o];
            delete files[o];
        },
    };
}

function makeCache(): BeautifyCache {
    const adapter = makeAdapter();
    return new BeautifyCache({ app: { vault: { adapter } }, manifest: { dir: 'plugins/test' } } as any);
}

function makeHost(overrides: Partial<BeautifyHost> = {}): BeautifyHost {
    const host: BeautifyHost = {
        resolveEmbed: vi.fn((linkPath: string) => (linkPath.startsWith('missing') ? null : { path: `assets/${linkPath}` })),
        transcribeImage: vi.fn(async () => 'extracted text from the image'),
        retrieveRelated: vi.fn(async () => []),
        beautifyViaLLM: vi.fn(async (payload) => payload),
    };
    return { ...host, ...overrides };
}

const BASE_OPTS: BeautifyOptions = { relatedNotes: true, imageCaptions: true, relatedTopK: 3 };

describe('extractEmbeds', () => {
    it('finds a plain embed', () => {
        expect(extractEmbeds('See ![[photo.png]] below')).toEqual([{ linkPath: 'photo.png' }]);
    });

    it('finds a sized embed and keeps the alt text', () => {
        expect(extractEmbeds('![[diagram.jpg|300]]')).toEqual([{ linkPath: 'diagram.jpg', alt: '300' }]);
    });

    it('handles folder paths and webp', () => {
        expect(extractEmbeds('![[assets/scan.webp]]')).toEqual([{ linkPath: 'assets/scan.webp' }]);
    });

    it('does not match plain wiki links', () => {
        expect(extractEmbeds('Refer to [[photo.png]] here')).toEqual([]);
    });

    it('does not match markdown image urls', () => {
        expect(extractEmbeds('![alt](https://example.com/x.png)')).toEqual([]);
    });

    it('matches multiple embeds', () => {
        expect(extractEmbeds('a ![[one.png]] b ![[two.jpeg|100]]')).toHaveLength(2);
    });

    it('dedupes the same image embedded more than once (first embed wins)', () => {
        expect(extractEmbeds('![[photo.png]] and again ![[photo.png|300]]')).toEqual([{ linkPath: 'photo.png' }]);
    });
});

describe('basenameOf', () => {
    it('strips a folder path and extension', () => {
        expect(basenameOf('assets/Photo.md')).toBe('Photo');
    });

    it('keeps a plain name untouched', () => {
        expect(basenameOf('Thorium')).toBe('Thorium');
    });

    it('strips image extensions too', () => {
        expect(basenameOf('assets/scan.webp')).toBe('scan');
    });
});

describe('extractOriginalLinks', () => {
    it('collects basenames of wiki links but not embeds', () => {
        const set = extractOriginalLinks('see [[Thorium]] and [[Assets/Pump|pump]], embed ![[photo.png]]');
        expect(set.has('Thorium')).toBe(true);
        expect(set.has('Pump')).toBe(true);
        expect(set.has('photo.png')).toBe(false);
    });
});

describe('reviewWhitelist', () => {
    it('keeps candidate links', () => {
        const out = reviewWhitelist('see [[Thorium]]', ['Thorium'], []);
        expect(out).toBe('see [[Thorium]]');
    });

    it('keeps pre-existing original links', () => {
        const out = reviewWhitelist('kept [[Old Note]]', ['Thorium'], ['Old Note']);
        expect(out).toBe('kept [[Old Note]]');
    });

    it('strips hallucinated links', () => {
        const out = reviewWhitelist('see [[Invented Note]] here', ['Thorium'], []);
        expect(out).toBe('see  here');
    });

    it('keeps embeds even when not in the whitelist', () => {
        const out = reviewWhitelist('![[photo.png|200]] stays', ['Thorium'], []);
        expect(out).toBe('![[photo.png|200]] stays');
    });

    it('keeps alias links to allowed basenames', () => {
        const out = reviewWhitelist('[[Thorium|the element]]', ['Thorium'], []);
        expect(out).toBe('[[Thorium|the element]]');
    });
});

describe('buildPayload', () => {
    const content = '# Title\n\nBody text.';

    it('wraps the note in markers when there is no enrichment', () => {
        const payload = buildPayload(content, [], []);
        expect(payload).toContain('=== NOTE CONTENT TO BEAUTIFY ===');
        expect(payload).toContain(content);
        expect(payload).toContain('================================');
        expect(payload).not.toContain('EMBEDDED IMAGE TRANSCRIPTIONS');
        expect(payload).not.toContain('RELATED NOTE CANDIDATES');
    });

    it('adds an image transcription section when present', () => {
        const payload = buildPayload(content, [{ linkPath: 'photo.png', filePath: 'assets/photo.png', transcription: 'alt text' }], []);
        expect(payload).toContain('=== EMBEDDED IMAGE TRANSCRIPTIONS');
        expect(payload).toContain('[IMAGE: assets/photo.png]');
        expect(payload).toContain('alt text');
    });

    it('skips images without a transcription', () => {
        const payload = buildPayload(content, [{ linkPath: 'photo.png', filePath: 'assets/photo.png' }], []);
        expect(payload).not.toContain('EMBEDDED IMAGE TRANSCRIPTIONS');
    });

    it('adds the related candidates section', () => {
        const payload = buildPayload(content, [], [{ name: 'Thorium', snippet: 'safety notes' }]);
        expect(payload).toContain('=== RELATED NOTE CANDIDATES');
        expect(payload).toContain('Thorium | safety notes');
    });
});

describe('collectImageContext', () => {
    it('transcribes resolved embeds in order', async () => {
        const host = makeHost();
        const images = await collectImageContext('a ![[one.png]] b ![[two.jpeg]]', 'Note.md', host);
        expect(images.map(i => i.filePath)).toEqual(['assets/one.png', 'assets/two.jpeg']);
        expect(images.every(i => i.transcription === 'extracted text from the image')).toBe(true);
    });

    it('caps at maxImages', async () => {
        const host = makeHost();
        const images = await collectImageContext('![[a.png]] ![[b.png]] ![[c.png]]', 'Note.md', host, 2);
        expect(images).toHaveLength(2);
    });

    it('keeps unresolved embeds without transcription', async () => {
        const host = makeHost();
        const images = await collectImageContext('![[missing.png]]', 'Note.md', host);
        expect(images[0].filePath).toBeUndefined();
        expect(images[0].transcription).toBeUndefined();
    });

    it('is fail-tolerant when the vision call rejects', async () => {
        const host = makeHost({ transcribeImage: vi.fn(async () => { throw new Error('vision down'); }) });
        const images = await collectImageContext('![[one.png]]', 'Note.md', host);
        expect(images[0].linkPath).toBe('one.png');
        expect(images[0].transcription).toBeUndefined();
    });
});

describe('collectRelated', () => {
    it('omits the source file and dedupes by basename', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => [
                { filePath: 'Note.md', text: 'self, should be dropped' },
                { filePath: 'a/Thorium.md', text: 'safety notes\nmore' },
                { filePath: 'b/Thorium.md', text: 'duplicate basename' },
            ]),
        });
        const related = await collectRelated('content', 'Note.md', host, 5);
        expect(related.map(r => r.name)).toEqual(['Thorium']);
        expect(related[0].snippet).toBe('safety notes');
    });
});

describe('beautifyNote', () => {
    it('enriches, beautifies and whitelist-guards the result', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => [
                { filePath: 'Thorium.md', text: 'safety notes' },
                { filePath: 'z/Enrichment.md', text: 'indexing' },
            ]),
            beautifyViaLLM: vi.fn(async () => 'clean note ## Related Notes\n- [[Thorium]] - matches\n- [[Made Up]] - hmm'),
        });
        const result = await beautifyNote('body', 'Note.md', host, BASE_OPTS);
        expect(result).toContain('- [[Thorium]]');
        expect(result).not.toContain('[[Made Up]]');
        expect(host.beautifyViaLLM).toHaveBeenCalledWith(
            expect.stringContaining('RELATED NOTE CANDIDATES'),
            { relatedNotes: true, imageCaptions: true }
        );
    });

    it('skips enrichment when the settings turn it off', async () => {
        const host = makeHost({ beautifyViaLLM: vi.fn(async () => 'clean') });
        const result = await beautifyNote('a ![[one.png]]', 'Note.md', host, {
            relatedNotes: false,
            imageCaptions: false,
            relatedTopK: 3,
        });
        expect(result).toBe('clean');
        expect(host.beautifyViaLLM).toHaveBeenCalledWith(
            expect.not.stringContaining('RELATED NOTE CANDIDATES'),
            { relatedNotes: false, imageCaptions: false }
        );
        expect(host.retrieveRelated).not.toHaveBeenCalled();
        expect(host.transcribeImage).not.toHaveBeenCalled();
    });
});

describe('beautifyNote with cache', () => {
    const identity = { model: 'm1', optsHash: 'o1' };

    it('returns the cached output with 0 LLM calls when the page is unchanged', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifyViaLLM: vi.fn(async () => 'v1 result'),
        });
        const cache = makeCache();
        const first = await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity);
        expect(first).toBe('v1 result');
        const second = await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity);
        expect(second).toBe('v1 result');
        expect(host.beautifyViaLLM).toHaveBeenCalledTimes(1);
    });

    it('force bypasses the no-op guard and still refreshes the cache', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifyViaLLM: vi.fn(async () => 'v1 result'),
        });
        const cache = makeCache();
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity);
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity, true);
        expect(host.beautifyViaLLM).toHaveBeenCalledTimes(2);
    });

    it('misses when the content, model, or opts key change', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifyViaLLM: vi.fn(async () => 'v1 result'),
        });
        const cache = makeCache();
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity);
        await beautifyNote('hello world changed', 'note.md', host, BASE_OPTS, 5, cache, identity);
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, { model: 'm2', optsHash: 'o1' });
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, { model: 'm1', optsHash: 'o2' });
        expect(host.beautifyViaLLM).toHaveBeenCalledTimes(4);
    });

    it('only caches when both cache and identity are supplied', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifyViaLLM: vi.fn(async () => 'v1 result'),
        });
        const cache = makeCache();
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, null);
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, null, identity);
        await beautifyNote('hello world', 'note.md', host, BASE_OPTS, 5, cache, identity);
        expect(host.beautifyViaLLM).toHaveBeenCalledTimes(3);
    });
});

describe('beautifySelection', () => {
    const opts = { relatedNotes: false, relatedTopK: 3 };

    it('returns a cached block with 0 LLM calls for the same source', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifySelectionViaLLM: vi.fn(async (t: string) => `cleaned: ${t}`),
        });
        const cache = makeCache();
        const identity = { model: 'm1', optsHash: 'o1' };
        const first = await beautifySelection('**raw** text', 'note.md', host, opts, cache, identity);
        const second = await beautifySelection('**raw** text', 'note.md', host, opts, cache, identity);
        expect(first).toBe('cleaned: **raw** text');
        expect(second).toBe(first);
        expect(host.beautifySelectionViaLLM).toHaveBeenCalledTimes(1);
    });

    it('misses when the source differs', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifySelectionViaLLM: vi.fn(async () => 'cleaned'),
        });
        const cache = makeCache();
        const identity = { model: 'm1', optsHash: 'o1' };
        await beautifySelection('one', 'note.md', host, opts, cache, identity);
        await beautifySelection('two', 'note.md', host, opts, cache, identity);
        expect(host.beautifySelectionViaLLM).toHaveBeenCalledTimes(2);
    });

    it('model change invalidates the block cache', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifySelectionViaLLM: vi.fn(async () => 'cleaned'),
        });
        const cache = makeCache();
        await beautifySelection('one', 'note.md', host, opts, cache, { model: 'm1', optsHash: 'o1' });
        await beautifySelection('one', 'note.md', host, opts, cache, { model: 'm2', optsHash: 'o1' });
        expect(host.beautifySelectionViaLLM).toHaveBeenCalledTimes(2);
    });

    it('whitelists hallucinated links after selection beautify', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => [{ filePath: 'Thorium.md', text: 'safety notes' }]),
            beautifySelectionViaLLM: vi.fn(async () => 'see [[Thorium]] and [[Invented Note]]'),
        });
        const cache = makeCache();
        const result = await beautifySelection('raw', 'note.md', host, { relatedNotes: true, relatedTopK: 3 }, cache, { model: 'm1', optsHash: 'o1' });
        expect(result).toContain('[[Thorium]]');
        expect(result).not.toContain('[[Invented Note]]');
    });

    it('throws when the host has no selection beautifier', async () => {
        const host = makeHost();
        await expect(beautifySelection('raw', 'note.md', host, opts)).rejects.toThrow(/not supported/);
    });

    it('behaves without a cache (always calls the LLM)', async () => {
        const host = makeHost({
            retrieveRelated: vi.fn(async () => []),
            beautifySelectionViaLLM: vi.fn(async () => 'cleaned'),
        });
        await beautifySelection('one', 'note.md', host, opts, null, null);
        await beautifySelection('one', 'note.md', host, opts, null, null);
        expect(host.beautifySelectionViaLLM).toHaveBeenCalledTimes(2);
    });
});