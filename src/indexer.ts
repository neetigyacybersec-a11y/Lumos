import { TFile, Notice } from 'obsidian';
import LumosPlugin from './main';
import { RELATION_VIEW_TYPE, RelationSidebarView } from './sidebarView';
import { hashString, isPathIgnored } from './utils';
import { IndexingProgressUI } from './progressUi';
const pdfParse = require('pdf-parse');

export class BackgroundIndexer {
    plugin: LumosPlugin;
    queue: TFile[] = [];
    isProcessing: boolean = false;
    progressUi: IndexingProgressUI;
    totalFiles: number = 0;
    processedFiles: number = 0;

    constructor(plugin: LumosPlugin) {
        this.plugin = plugin;
        this.progressUi = new IndexingProgressUI();
    }

    async start() {
        const files = this.plugin.app.vault.getFiles();
        let added = 0;
        
        for (const file of files) {
            const ext = file.extension.toLowerCase();
            if (!['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) continue;
            if (file.path === this.plugin.settings.userProfilePath) continue;
            if (isPathIgnored(file.path, this.plugin.settings.ignoredFolders)) continue;

            if (!this.plugin.vectorStore.hasFile(file.path)) {
                this.queue.push(file);
                added++;
            }
        }

        if (added > 0) {
            this.totalFiles = added;
            this.processedFiles = 0;
            this.progressUi.show(this.totalFiles);
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        this.plugin.userProfileManager.pauseUpdates();

        while (this.queue.length > 0) {
            const file = this.queue.shift();
            if (!file) continue;

            try {
                // Check if file was somehow deleted while waiting
                if (!(await this.plugin.app.vault.adapter.exists(file.path))) {
                    continue;
                }

                const ext = file.extension.toLowerCase();
                let cleanText = '';
                let madeNetworkCall = false;

                if (ext === 'md') {
                    const parsed = await this.plugin.parser.parse(file);
                    cleanText = parsed.cleanText;
                } else if (ext === 'pdf') {
                    try {
                        const buffer = await this.plugin.app.vault.readBinary(file);
                        const data = await pdfParse(Buffer.from(buffer));
                        cleanText = data.text;
                    } catch (e) {
                        console.error(`Failed to parse PDF ${file.path}`, e);
                        continue;
                    }
                } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
                    try {
                        const hasText = await this.plugin.localOcr.hasText(file);
                        if (hasText) {
                            cleanText = await this.plugin.visionExtractor.extractImageText(file);
                            madeNetworkCall = true;
                        } else {
                            continue;
                        }
                    } catch (e) {
                        console.error(`Failed OCR on Image ${file.path}`, e);
                        continue;
                    }
                }

                if (!cleanText || cleanText.trim() === '') continue;
                
                // 2. Embed
                const contentHash = hashString(cleanText);
                const chunks = this.plugin.embeddingPipeline.chunkText(cleanText);
                let firstEmbedding: number[] | null = null;
                const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
                    const embedding = await this.plugin.embeddingPipeline.embed(text);
                    madeNetworkCall = true;
                    if (i === 0) firstEmbedding = embedding;
                    return { id: `${file.path}#${i}`, filePath: file.path, text, embedding, contentHash };
                }));
                await this.plugin.vectorStore.upsert(file.path, vectorChunks, true);
                
                // 3. Extract Relations (only if it has similar notes to compare to, and only for markdown files)
                if (ext === 'md' && firstEmbedding && this.plugin.vectorStore.getFileCount() > 1) {
                    const similar = this.plugin.vectorStore.querySimilar(firstEmbedding, 3, file.path);
                    if (similar.length > 0) {
                        const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
                        const prompt = this.plugin.relationExtractor.constructPrompt(file.path, cleanText, candidates);
                        const { edges, profileInsights } = await this.plugin.relationExtractor.extractRelations(prompt, file.path);
                        madeNetworkCall = true;
                        
                        if (profileInsights) {
                            await this.plugin.userProfileManager.addInsight(profileInsights);
                        }

                        // Compute final scores
                        const scoredEdges = edges.map(edge => {
                            const targetFile = this.plugin.app.vault.getAbstractFileByPath(edge.target);
                            if (!(targetFile instanceof TFile)) return edge;
                            
                            const simMatch = similar.find(s => s.filePath === edge.target);
                            const cosine = simMatch ? simMatch.similarity : 0;
                            
                            edge.scores = this.plugin.scoringEngine.calculateOverallScore(file, targetFile, cosine, edge.confidence);
                            return edge;
                        });

                        await this.plugin.relationStore.upsertEdges(file.path, scoredEdges, true);
                        
                        // Process Backlinks
                        await this.plugin.backlinkManager.processEdges(file, edges);
                    } else {
                        await this.plugin.userProfileManager.addActivity(cleanText);
                    }
                } else if (ext === 'md') {
                    await this.plugin.userProfileManager.addActivity(cleanText);
                }
            } catch (e) {
                console.error(`[RelationPlugin] Failed to index ${file.path}`, e);
            }

            this.processedFiles++;
            this.progressUi.update(this.processedFiles, file.name);

            // Batch save every 10 files to avoid data loss while preventing I/O thrashing
            if (this.processedFiles % 10 === 0) {
                await this.plugin.vectorStore.forceSave();
                await this.plugin.relationStore.forceSave();
            }

            // Sleep a bit to avoid hitting rate limits, but ONLY if we actually made a network call
            if (madeNetworkCall) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // Final forced save once everything is queued
        await this.plugin.vectorStore.forceSave();
        await this.plugin.relationStore.forceSave();

        // Ensure profile file exists so the user knows where it is
        const path = this.plugin.settings.userProfilePath;
        if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
            await this.plugin.app.vault.create(path, "# AI User Profile\n\n*No profile insights have been extracted yet. Keep writing notes!*");
        }
        
        this.plugin.userProfileManager.resumeUpdates();
        await this.plugin.userProfileManager.flush();

        this.isProcessing = false;
        this.progressUi.hide();
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
