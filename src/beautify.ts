import { Logger } from './logger';
import { hashString } from './utils';
import { BeautifyBlockRecord, BeautifyNoteRecord } from './beautifyCache';

/** Structural stand-in for obsidian's TFile so this module stays testable. */
export interface VaultFilePath {
    path: string;
}

export interface ImageEmbed {
    linkPath: string;
    alt?: string;
    filePath?: string;
    transcription?: string;
}

export interface RelatedCandidate {
    name: string;
    snippet: string;
}

export interface BeautifyHost {
    resolveEmbed(linkPath: string, sourcePath: string): VaultFilePath | null;
    transcribeImage(file: VaultFilePath): Promise<string>;
    retrieveRelated(query: string, topK: number, excludeFilePath: string): Promise<{ filePath: string; text: string }[]>;
    beautifyViaLLM(payload: string, opts: BeautifyOptions): Promise<string>;
    beautifySelectionViaLLM?(text: string): Promise<string>;
}

export interface BeautifyOptions {
    relatedNotes: boolean;
    imageCaptions: boolean;
    relatedTopK: number;
}

export interface BeautifyIdentity {
    model: string;
    optsHash: string;
}

export interface BeautifyCacheOps {
    getNote(path: string): BeautifyNoteRecord | null;
    setWhole(path: string, whole: Omit<BeautifyNoteRecord, 'updatedAt' | 'blocks'>): void;
    invalidateNote(path: string, skipSave?: boolean): void;
    getBlock(path: string, key: string): BeautifyBlockRecord | null;
    setBlock(path: string, block: BeautifyBlockRecord): void;
}

const EMBED_RE = /!\[\[([^\[\]|#]+?\.(?:png|jpe?g|webp))(?:\|([^\]]*))?\]\]/gi;

/** Pull embedded local images out of a markdown doc as `![[folder/photo.png]]` (with optional |size/alt). */
export function extractEmbeds(content: string): ImageEmbed[] {
    const seen = new Set<string>();
    const images: ImageEmbed[] = [];
    for (const match of content.matchAll(EMBED_RE)) {
        const linkPath = match[1].trim();
        if (seen.has(linkPath)) continue;
        seen.add(linkPath);
        const alt = (match[2] || '').trim();
        images.push({
            linkPath,
            ...(alt ? { alt } : {}),
        });
    }
    return images;
}

export function basenameOf(pathOrName: string): string {
    let base = pathOrName.includes('/') ? pathOrName.split('/').pop() || pathOrName : pathOrName;
    base = base.replace(/\.(png|jpe?g|webp|md)$/i, '');
    return base;
}

/** Basenames of every `[[...]]` token in the original so the whitelist never strips pre-existing links. */
export function extractOriginalLinks(content: string): Set<string> {
    const found = new Set<string>();
    for (const match of content.matchAll(/(?<!!)\[\[([^\[\]|#]+?)(?:\|[^\]]*)?\]\]/g)) {
        found.add(basenameOf(match[1].trim()));
    }
    return found;
}

/**
 * Deterministic guard against hallucinated wiki links: any `[[Name]]` token that is
 * neither a provided related candidate nor a pre-existing link in the note is removed.
 * Embeds (`![[...]]`) are always preserved.
 */
export function reviewWhitelist(output: string, candidates: Iterable<string>, originalLinks: Iterable<string>): string {
    const allowed = new Set<string>([...candidates, ...originalLinks].map(basenameOf));
    return output.replace(/(!?)\[\[([^\[\]|#]+?)(?:\|[^\]]*)?\]\]/g, (full, bang: string, name: string) => {
        const base = name.trim();
        if (bang || allowed.has(base) || allowed.has(basenameOf(base))) return full;
        return '';
    });
}

/** Transcribe up to maxImages embedded images in parallel; failures just skip the caption. */
export async function collectImageContext(
    content: string,
    sourcePath: string,
    host: BeautifyHost,
    maxImages: number = 5
): Promise<ImageEmbed[]> {
    const embeds = extractEmbeds(content).slice(0, Math.max(0, maxImages));
    const settled = await Promise.allSettled(
        embeds.map(async (embed) => {
            const file = host.resolveEmbed(embed.linkPath.split('#')[0], sourcePath);
            if (!file) return embed;
            const transcription = await host.transcribeImage(file);
            return { ...embed, filePath: file.path, transcription };
        })
    );
    return settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        Logger.warn('[Lumos] Image transcription skipped', s.reason);
        return embeds[i];
    });
}

export async function collectRelated(content: string, sourcePath: string, host: BeautifyHost, topK: number): Promise<RelatedCandidate[]> {
    const results = await host.retrieveRelated(content, Math.max(1, topK), sourcePath);
    const seen = new Set<string>();
    const candidates: RelatedCandidate[] = [];
    for (const r of results) {
        if (r.filePath === sourcePath) continue;
        const name = basenameOf(r.filePath);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        candidates.push({ name, snippet: r.text.split('\n')[0].slice(0, 200) });
    }
    return candidates;
}

/** User-message payload: the note to beautify, plus information-only supplementary sections. */
export function buildPayload(content: string, images: ImageEmbed[], related: RelatedCandidate[]): string {
    const parts: string[] = [
        '=== NOTE CONTENT TO BEAUTIFY ===\n' + content + '\n================================',
    ];
    const transcribed = images.filter(i => i.transcription);
    if (transcribed.length > 0) {
        parts.push(
            '=== EMBEDDED IMAGE TRANSCRIPTIONS (information only; not part of the note) ===\n' +
            transcribed
                .map(i => `[IMAGE: ${i.filePath || i.linkPath}]\n${i.transcription}`)
                .join('\n\n')
        );
    }
    if (related.length > 0) {
        parts.push(
            '=== RELATED NOTE CANDIDATES (only candidates; use [[basename]] to link) ===\n' +
            related.map(r => `${r.name} | ${r.snippet}`).join('\n')
        );
    }
    return parts.join('\n\n');
}

/** Enrich a note with image transcriptions + related-note candidates, beautify, then guard the links. */
export async function beautifyNote(
    content: string,
    sourcePath: string,
    host: BeautifyHost,
    opts: BeautifyOptions,
    maxImages: number = 5,
    cache: BeautifyCacheOps | null = null,
    identity: BeautifyIdentity | null = null,
    force = false
): Promise<string> {
    if (cache && identity && !force) {
        const record = cache.getNote(sourcePath);
        if (
            record?.wholeBeautified &&
            record.sourceHash === (await hashString(content)) &&
            record.model === identity.model &&
            record.optsHash === identity.optsHash
        ) {
            return record.wholeBeautified;
        }
    }

    const originalLinks = extractOriginalLinks(content);

    const images = opts.imageCaptions
        ? await collectImageContext(content, sourcePath, host, maxImages)
        : [];

    const related = opts.relatedNotes
        ? await collectRelated(content, sourcePath, host, opts.relatedTopK)
        : [];

    const payload = buildPayload(content, images, related);
    const beautified = await host.beautifyViaLLM(payload, {
        relatedNotes: opts.relatedNotes,
        imageCaptions: opts.imageCaptions,
    });

    const guarded = reviewWhitelist(beautified, related.map(r => r.name), originalLinks);

    if (cache && identity) {
        cache.setWhole(sourcePath, {
            sourceHash: await hashString(content),
            wholeBeautified: guarded,
            model: identity.model,
            optsHash: identity.optsHash,
        });
    }

    return guarded;
}

/** Beautify a single selection/block with the compact copyedit prompt, caching per-source. */
export async function beautifySelection(
    source: string,
    sourcePath: string,
    host: BeautifyHost,
    opts: { relatedNotes: boolean; relatedTopK: number },
    cache: BeautifyCacheOps | null = null,
    identity: BeautifyIdentity | null = null
): Promise<string> {
    if (!host.beautifySelectionViaLLM) {
        throw new Error('Selection beautify is not supported by this host.');
    }
    const key = cache && identity ? await hashString(source) : '';
    if (cache && identity) {
        const cached = cache.getBlock(sourcePath, key);
        if (cached && cached.model === identity.model) return cached.beautified;
    }

    const related = opts.relatedNotes
        ? await collectRelated(source, sourcePath, host, opts.relatedTopK)
        : [];
    const originalLinks = extractOriginalLinks(source);
    const beautified = await host.beautifySelectionViaLLM(source);
    const guarded = reviewWhitelist(beautified, related.map(r => r.name), originalLinks);

    if (cache && identity) {
        cache.setBlock(sourcePath, {
            key,
            source,
            beautified: guarded,
            model: identity.model,
            cachedAt: Date.now(),
        });
    }

    return guarded;
}