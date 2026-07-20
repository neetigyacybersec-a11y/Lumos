import { TFile, Notice } from 'obsidian';
import RelationPlugin from './main';
import { RELATION_VIEW_TYPE, RelationSidebarView } from './sidebarView';
import { hashString } from './utils';

export class BackgroundIndexer {
    plugin: RelationPlugin;
    queue: TFile[] = [];
    isProcessing: boolean = false;

    constructor(plugin: RelationPlugin) {
        this.plugin = plugin;
    }

    async start() {
        const files = this.plugin.app.vault.getMarkdownFiles();
        let added = 0;
        
        for (const file of files) {
            if (!this.plugin.vectorStore.hasFile(file.path)) {
                this.queue.push(file);
                added++;
            }
        }

        if (added > 0) {
            new Notice(`[LLM Relations] Found ${added} unindexed notes. Indexing in background...`);
            this.processQueue();
        } else {
            console.log('[RelationPlugin] Vault is fully indexed.');
        }
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const file = this.queue.shift();
            if (!file) continue;

            try {
                // Check if file was somehow deleted while waiting
                if (!(await this.plugin.app.vault.adapter.exists(file.path))) {
                    continue;
                }

                // 1. Parse
                const parsed = await this.plugin.parser.parse(file);
                
                // 2. Embed
                const contentHash = hashString(parsed.cleanText);
                const chunks = this.plugin.embeddingPipeline.chunkText(parsed.cleanText);
                let firstEmbedding: number[] | null = null;
                const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
                    const embedding = await this.plugin.embeddingPipeline.embed(text);
                    if (i === 0) firstEmbedding = embedding;
                    return { id: `${file.path}#${i}`, filePath: file.path, text, embedding, contentHash };
                }));
                await this.plugin.vectorStore.upsert(file.path, vectorChunks);
                
                // 3. Extract Relations (only if it has similar notes to compare to)
                if (firstEmbedding && this.plugin.vectorStore.getFileCount() > 1) {
                    const similar = this.plugin.vectorStore.querySimilar(firstEmbedding, 3, file.path);
                    if (similar.length > 0) {
                        const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
                        const prompt = this.plugin.relationExtractor.constructPrompt(file.path, parsed.cleanText, candidates);
                        const edges = await this.plugin.relationExtractor.extractRelations(prompt, file.path);
                        
                        // Compute final scores
                        const scoredEdges = edges.map(edge => {
                            const targetFile = this.plugin.app.vault.getAbstractFileByPath(edge.target);
                            if (!(targetFile instanceof TFile)) return edge;
                            
                            const simMatch = similar.find(s => s.filePath === edge.target);
                            const cosine = simMatch ? simMatch.similarity : 0;
                            
                            edge.scores = this.plugin.scoringEngine.calculateOverallScore(file, targetFile, cosine, edge.confidence);
                            return edge;
                        });

                        await this.plugin.relationStore.upsertEdges(file.path, scoredEdges);
                        
                        // Process Backlinks
                        await this.plugin.backlinkManager.processEdges(file, edges);
                    }
                }
            } catch (e) {
                console.error(`[RelationPlugin] Failed to index ${file.path}`, e);
            }

            // Sleep a bit to avoid locking the UI and hitting rate limits too hard
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        // Final forced save once everything is queued
        await this.plugin.vectorStore.save();
        await this.plugin.relationStore.save();

        this.isProcessing = false;
        new Notice(`[LLM Relations] Initial vault indexing complete!`);
        
        // Trigger UI refresh
        const leaves = this.plugin.app.workspace.getLeavesOfType(RELATION_VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof RelationSidebarView) {
                leaf.view.render();
            }
        }
    }
}
