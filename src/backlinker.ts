import { Logger } from './logger';
import { App, TFile } from 'obsidian';
import { PluginSettings } from './types';
import { RelationEdge } from './relationStore';

/**
 * Wikilink values the plugin persists (e.g. `[[Splunk]]`).
 */
const WIKILINK_RE = /^\[\[[^\[\]!\r\n]+\]\]$/;
/**
 * Plain, YAML-safe basenames (e.g. older builds stored `Splunk` without
 * brackets). Anything else — embeds (`![[...]]`), tags, flow scalars — is
 * hostile to Obsidian's frontmatter serializer and gets dropped.
 */
const SAFE_BARE_RE = /^(?=.*[A-Za-z])[A-Za-z0-9 _.'()-]+$/;

/**
 * Normalise an unknown ai_relations payload to a clean, YAML-safe list of
 * wikilink strings. Drops `![[...]]` embeds and any value that would break
 * Obsidian's frontmatter serialiser (`YAMLParseError: Tags and anchors must
 * be separated from the next token by white space`), and deduplicates.
 */
export function sanitizeRelations(values: unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (!t) continue;
        if (!WIKILINK_RE.test(t) && !SAFE_BARE_RE.test(t)) continue;
        const norm = t.toLowerCase().replace(/\[\[|\]\]/g, '');
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(WIKILINK_RE.test(t) ? t : `[[${t}]]`);
    }
    return out;
}

/**
 * Line-based repair of a corrupt `ai_relations` block inside YAML frontmatter.
 *
 * `processFrontMatter` cannot parse a file whose frontmatter is unreadable
 * (e.g. an older build persisted an unquoted `- ![[...]]` embed), so when the
 * write path throws we rewrite just the `ai_relations` block from raw text:
 * preserve everything else verbatim, keep only YAML-safe wikilinks, append the
 * new links, and quote every value.
 */
export function repairAiRelationsBlock(data: string, newLinksToAdd: string[]): string {
    const fm = data.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!fm) return data;
    const lines = fm[1].split(/\r?\n/);

    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^ai_relations\s*:/.test(lines[i].trim())) {
            idx = i;
            break;
        }
    }
    if (idx < 0) return data;

    // Scrape the existing list items (quoted or not) until the next key.
    const existing: string[] = [];
    let endIdx = idx;
    for (let i = idx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^[-+*]\s+/.test(t)) {
            endIdx = i;
            existing.push(t.replace(/^[-+*]\s+/, '').replace(/^["']|["']$/g, ''));
            continue;
        }
        if (t === '') continue;
        if (/^[A-Za-z0-9_-]+\s*:/.test(t)) break;
        endIdx = i;
        existing.push(t);
    }

    const merged = sanitizeRelations(existing);
    const seen = new Set(merged.map((s) => s.toLowerCase()));
    for (const l of newLinksToAdd) {
        if (l && !seen.has(l.toLowerCase())) {
            seen.add(l.toLowerCase());
            merged.push(l);
        }
    }

    const indent = /^\s*/.exec(lines[idx])?.[0] ?? '';
    const rebuilt = [
        ...lines.slice(0, idx),
        `${indent}ai_relations:`,
        ...merged.map((v) => `${indent}  - ${JSON.stringify(v)}`),
    ];
    const after = lines.slice(endIdx + 1);

    return data.replace(fm[0], `---\n${[...rebuilt, ...after].join('\n')}\n---\n`);
}

export class BacklinkManager {
    app: App;
    settings: PluginSettings;

    constructor(app: App, settings: PluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    async processEdges(sourceFile: TFile, edges: RelationEdge[]) {
        if (!this.settings.autoAddBacklinks || edges.length === 0) return;

        // 1. Filter by confidence
        const highConfidenceEdges = edges.filter(e => e.confidence >= this.settings.backlinkConfidenceThreshold);
        if (highConfidenceEdges.length === 0) return;

        // 2. Get existing links
        const cache = this.app.metadataCache.getFileCache(sourceFile);
        const existingLinks = new Set<string>();

        if (cache?.links) {
            for (const link of cache.links) {
                existingLinks.add(link.link); // Usually just the basename or path
            }
        }

        // Also check existing frontmatter ai_relations (sanitized: a stale
        // `![[...]]` embed would otherwise poison the write back to disk).
        if (cache?.frontmatter?.ai_relations) {
            const fmRelations = cache.frontmatter.ai_relations;
            if (Array.isArray(fmRelations)) {
                for (const r of sanitizeRelations(fmRelations)) {
                    existingLinks.add(r);
                }
            }
        }

        const newLinksToAdd: string[] = [];
        for (const edge of highConfidenceEdges) {
            // target is usually the full path: folder/Note.md
            // extract the basename without extension
            const targetPath = edge.target;
            const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
            let linkText = '';

            if (targetFile instanceof TFile) {
                // If we found the file, use its basename
                linkText = targetFile.basename;
            } else {
                // Fallback to manual parsing
                linkText = targetPath.replace(/\.[^/.]+$/, "").split('/').pop() || '';
            }

            if (!linkText) continue;

            const wikilink = `[[${linkText}]]`;

            // Check if link exists in body or already in our list
            if (!existingLinks.has(linkText) && !existingLinks.has(wikilink)) {
                newLinksToAdd.push(wikilink);
                existingLinks.add(wikilink);
            }
        }

        if (newLinksToAdd.length === 0) return;

        // 3. Inject new links into frontmatter
        try {
            await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter) => {
                const existing = Array.isArray(frontmatter.ai_relations)
                    ? frontmatter.ai_relations
                    : typeof frontmatter.ai_relations === 'string'
                        ? [frontmatter.ai_relations]
                        : [];
                // Replace, never append: this is what evicts any corrupt
                // `![[...]]` entry so the serializer writes safe YAML.
                frontmatter.ai_relations = sanitizeRelations(existing);

                // Add the new links
                frontmatter.ai_relations.push(...newLinksToAdd);

                // Remove duplicates just in case
                frontmatter.ai_relations = [...new Set(frontmatter.ai_relations)];
            });
        } catch (e) {
            // The frontmatter is unparseable (corrupt ai_relations), so the
            // serializer cannot be used at all. Repair the block from raw text.
            try {
                await this.app.vault.process(sourceFile, (data) =>
                    repairAiRelationsBlock(data, newLinksToAdd)
                );
                Logger.warn(`[Lumos] Repaired corrupt ai_relations frontmatter in ${sourceFile.path}`);
            } catch (e2) {
                Logger.error(`[Lumos] Failed to inject backlinks into ${sourceFile.path}`, e2);
            }
        }
    }
}