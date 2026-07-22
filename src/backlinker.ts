import { Logger } from './logger';
import { App, TFile } from 'obsidian';
import { PluginSettings } from './types';
import { RelationEdge } from './relationStore';

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
        
        // Also check existing frontmatter ai_relations
        if (cache?.frontmatter?.ai_relations) {
            const fmRelations = cache.frontmatter.ai_relations;
            if (Array.isArray(fmRelations)) {
                for (const r of fmRelations) {
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
                if (!frontmatter.ai_relations) {
                    frontmatter.ai_relations = [];
                } else if (!Array.isArray(frontmatter.ai_relations)) {
                    // if for some reason it's a string, convert to array
                    frontmatter.ai_relations = [frontmatter.ai_relations];
                }
                
                // Add the new links
                frontmatter.ai_relations.push(...newLinksToAdd);
                
                // Remove duplicates just in case
                frontmatter.ai_relations = [...new Set(frontmatter.ai_relations)];
            });
        } catch (e) {
            Logger.error(`[Lumos] Failed to inject backlinks into ${sourceFile.path}`, e);
        }
    }
}
