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
    BeautifyHost,
    BeautifyOptions,
} from '../src/beautify';

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