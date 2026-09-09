import { PluginSettings } from './types';
import { createTransport } from './llm/transport';

/**
 * Splits an oversized paragraph (longer than `cap`) into pieces at sentence
 * boundaries (". ", "! ", "? ", "\n") falling back to whitespace, so no single
 * chunk exceeds the embedding window. Deterministic left-to-right greedy fill.
 */
function splitLongFragment(text: string, cap: number): string[] {
    const pieces: string[] = [];
    let remaining = text.trim();
    const seps = ['. ', '! ', '? ', '\n', ' '];
    while (remaining.length > cap) {
        let cut = -1;
        let sepLen = 0;
        // Prefer the last sentence/line boundary within the cap.
        for (const sep of seps) {
            const idx = remaining.lastIndexOf(sep, cap);
            if (idx > 0) {
                cut = idx;
                sepLen = sep.length;
                break;
            }
        }
        if (cut <= 0) {
            // No boundary found within the window — hard-cut the paragraph.
            cut = cap;
            sepLen = 0;
        }
        const slice = remaining.slice(0, cut + sepLen).trim();
        if (slice) pieces.push(slice);
        remaining = remaining.slice(cut + sepLen).trim();
    }
    if (remaining) pieces.push(remaining);
    return pieces;
}

export class EmbeddingPipeline {
    settings: PluginSettings;

    constructor(settings: PluginSettings) {
        this.settings = settings;
    }

    chunkText(text: string, maxTokensApprox: number = 500): string[] {
        if (!text || text.trim() === '') return [];
        // Rough ~4 chars per token; this is the hard character ceiling per chunk.
        const hardCharCap = Math.max(4, maxTokensApprox * 4);

        // Split into paragraphs on blank lines, keeping heading lines attached
        // to the paragraph that starts with them.
        const rawParagraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

        // Oversized paragraphs (longer than the cap) must not become one giant
        // embedding window; split them at sentence-ish boundaries first. A heading
        // paragraph keeps its heading line intact (only its body text is split).
        const fragments: { text: string; isHeading: boolean }[] = [];
        for (const p of rawParagraphs) {
            const isHeading = /^#{1,6}\s+/.test(p);
            if (p.length <= hardCharCap) {
                fragments.push({ text: p, isHeading });
                continue;
            }
            if (isHeading) {
                const nl = p.indexOf('\n');
                const headingLine = nl === -1 ? p : p.slice(0, nl);
                const body = nl === -1 ? '' : p.slice(nl + 1).trim();
                fragments.push({ text: headingLine, isHeading: true });
                if (body) {
                    for (const piece of splitLongFragment(body, hardCharCap)) {
                        fragments.push({ text: piece, isHeading: false });
                    }
                }
            } else {
                for (const piece of splitLongFragment(p, hardCharCap)) {
                    fragments.push({ text: piece, isHeading: false });
                }
            }
        }

        const chunks: string[] = [];
        let current: string[] = [];

        const flush = () => {
            if (current.length > 0) {
                chunks.push(current.join('\n\n'));
                current = [];
            }
        };

        for (const frag of fragments) {
            // A new heading marks a new semantic unit: prefer to start a new
            // chunk so embeddings aren't blended across unrelated sections.
            const wouldExceed = current.length > 0 &&
                ((current.join('\n\n').length + frag.text.length + 2) > hardCharCap);
            if (frag.isHeading && current.length > 0) {
                flush();
            } else if (wouldExceed) {
                flush();
            }
            current.push(frag.text);
        }
        flush();

        return chunks;
    }

    async embed(text: string): Promise<number[]> {
        return createTransport(this.settings).embed(text);
    }
}
