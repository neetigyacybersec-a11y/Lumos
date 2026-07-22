import { TFile, Notice } from 'obsidian';
import LumosPlugin from './main';
import { RELATION_VIEW_TYPE, RelationSidebarView } from './sidebarView';
import { hashString, isPathIgnored } from './utils';
import { IndexingProgressUI } from './progressUi';
import { fetchAllCalendarEvents, GoogleEvent } from './googleCalendar';
import { TerminalApiError, TransientApiError } from './llmService';


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
        if (this.isProcessing) return;
        
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
        
        // After starting the queue for files, let's also fetch and index calendar events
        if (this.plugin.settings.googleSyncEnabled && this.plugin.settings.googleRefreshToken) {
            this.indexCalendarEvents();
        }
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        this.plugin.userProfileManager.pauseUpdates();

        let retryCount = 0;
        let cursor = 0;

        while (cursor < this.queue.length) {
            const file = this.queue[cursor];
            if (!file) {
                cursor++;
                continue;
            }

            let madeNetworkCall = false;

            try {
                // Check if file was somehow deleted while waiting
                if (!(await this.plugin.app.vault.adapter.exists(file.path))) {
                    this.processedFiles++;
                    this.progressUi.update(this.processedFiles, this.totalFiles, file.path);
                    continue;
                }

                const ext = file.extension.toLowerCase();
                let cleanText = '';
                let shouldSkip = false;

                if (ext === 'md') {
                    const parsed = await this.plugin.parser.parse(file);
                    cleanText = parsed.cleanText;
                } else if (ext === 'pdf') {
                    try {
                        cleanText = await this.plugin.parser.parsePdf(file);
                    } catch (e) {
                        console.error(`Failed to parse PDF ${file.path}`, e);
                        shouldSkip = true;
                    }
                } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
                    try {
                        const hasText = await this.plugin.localOcr.hasText(file);
                        if (hasText) {
                            cleanText = await this.plugin.visionExtractor.extractImageText(file);
                            madeNetworkCall = true;
                        } else {
                            shouldSkip = true;
                        }
                    } catch (e) {
                        console.error(`Failed OCR on Image ${file.path}`, e);
                        shouldSkip = true;
                    }
                }

                if (shouldSkip || !cleanText || cleanText.trim() === '') {
                    // Mark as indexed with 0 chunks so we don't process it on every startup
                    await this.plugin.vectorStore.upsert(file.path, []);
                } else {
                    const contentHash = hashString(cleanText);
                    if (this.plugin.vectorStore.getFileHash(file.path) === contentHash) {
                        console.log(`[Lumos] Skipping ${file.path} as content hash matches.`);
                        this.processedFiles++;
                        this.progressUi.update(this.processedFiles, this.totalFiles, file.name);
                        continue;
                    }
                    
                    // 2. Embed
                    const chunks = this.plugin.embeddingPipeline.chunkText(cleanText);
                    let firstEmbedding: number[] | null = null;
                    const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
                        const embedding = await this.plugin.embeddingPipeline.embed(text);
                        madeNetworkCall = true;
                        if (i === 0) firstEmbedding = embedding;
                        return { id: `${file.path}#${i}`, filePath: file.path, text, embedding, contentHash };
                    }));
                    await this.plugin.vectorStore.upsert(file.path, vectorChunks);
                    
                    // 3. Extract Relations (only if it has similar notes to compare to)
                    if (firstEmbedding && this.plugin.vectorStore.getFileCount() > 1) {
                        const similar = await this.plugin.vectorStore.querySimilar(firstEmbedding, 3, file.path);
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
                            if (ext === 'md') {
                                await this.plugin.backlinkManager.processEdges(file, edges);
                            }
                        } else {
                            await this.plugin.userProfileManager.addActivity(cleanText);
                        }
                    } else if (ext === 'md') {
                        await this.plugin.userProfileManager.addActivity(cleanText);
                    }
                }
                retryCount = 0; // Success, reset retries
            } catch (e) {
                if (e instanceof TerminalApiError) {
                    console.error(`[Lumos] Terminal API Error. Circuit breaking:`, e);
                    this.queue = this.queue.slice(cursor); // Preserve remaining queue
                    this.isProcessing = false;
                    this.progressUi.hide();
                    new Notice(`🚨 LLM Indexing Halted: ${e.message}`, 15000);
                    return; // Halt completely
                } else if (e instanceof TransientApiError && retryCount < 3) {
                    console.warn(`[Lumos] Transient API Error. Retrying (Attempt ${retryCount + 1})...`, e);
                    retryCount++;
                    const delay = 2000 * Math.pow(2, retryCount);
                    new Notice(`Network error, retrying in ${delay/1000}s...`, delay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Skip the rest, loop will pull the same file again (cursor not incremented)
                } else {
                    console.error(`[RelationPlugin] Failed to index ${file.path}`, e);
                    // Mark as processed with 0 chunks to prevent infinite poison-pill retry loops on startup
                    await this.plugin.vectorStore.upsert(file.path, []);
                    retryCount = 0;
                    cursor++; // Move past the poison pill
                }
            }

            this.processedFiles++;
            this.progressUi.update(this.processedFiles, this.totalFiles, file.name);
            cursor++; // Move to next file on success

            // Batch save every 10 files to avoid data loss while preventing I/O thrashing
            if (this.processedFiles % 10 === 0) {
                // await this.plugin.relationStore.forceSave();
            }

            // Sleep a bit to avoid hitting rate limits, but ONLY if we actually made a network call
            if (madeNetworkCall) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // Clean up queue when fully processed
        this.queue = [];

        // Final forced save once everything is queued
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

    async indexCalendarEvents() {
        if (!this.plugin.settings.googleSyncEnabled) return;
        
        const events = await fetchAllCalendarEvents(this.plugin);
        if (events.length === 0) return;
        
        let processedCount = 0;
        let retryCount = 0;
        let cursor = 0;
        
        while (cursor < events.length) {
            const event = events[cursor];
            if (!event) {
                cursor++;
                continue;
            }
            const virtualPath = `gcal://${event.id}`;
            const startDate = event.start.dateTime ? new Date(event.start.dateTime).toLocaleString() : event.start.date;
            let cleanText = `[Google Calendar Event]\nTitle: ${event.summary}\nDate: ${startDate}\n`;
            if (event.description) cleanText += `Description: ${event.description}\n`;
            if (event.attendees && event.attendees.length > 0) {
                const attendees = event.attendees.map(a => a.displayName || a.email).join(', ');
                cleanText += `Attendees: ${attendees}\n`;
            }
            
            const contentHash = hashString(cleanText);

            if (this.plugin.vectorStore.getFileHash(virtualPath) === contentHash) {
                continue;
            }

            try {
                // Embed
                const chunks = this.plugin.embeddingPipeline.chunkText(cleanText);
                let firstEmbedding: number[] | null = null;
                const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
                    const embedding = await this.plugin.embeddingPipeline.embed(text);
                    if (i === 0) firstEmbedding = embedding;
                    return { id: `${virtualPath}#${i}`, filePath: virtualPath, text, embedding, contentHash };
                }));
                await this.plugin.vectorStore.upsert(virtualPath, vectorChunks);
                
                // Extract Relations
                if (firstEmbedding && this.plugin.vectorStore.getFileCount() > 1) {
                    const similar = await this.plugin.vectorStore.querySimilar(firstEmbedding, 3, virtualPath);
                    if (similar.length > 0) {
                        const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
                        const prompt = this.plugin.relationExtractor.constructPrompt(virtualPath, cleanText, candidates);
                        const { edges } = await this.plugin.relationExtractor.extractRelations(prompt, virtualPath);
                        
                        // We do not compute overall scores for calendar events using the scoring engine because it expects TFile
                        // Just use confidence
                        const scoredEdges = edges.map(edge => {
                            edge.scores = { overall: edge.confidence, llm: edge.confidence, cosine: 0, keyword: 0, folder: 0, recency: 0 };
                            return edge;
                        });

                        await this.plugin.relationStore.upsertEdges(virtualPath, scoredEdges, true);
                    }
                }
                processedCount++;
                
                if (processedCount % 10 === 0) {
                // await this.plugin.vectorStore.forceSave();
                // await this.plugin.relationStore.forceSave();
                }
                
                await new Promise(resolve => setTimeout(resolve, 1500)); // Delay for rate limit
                retryCount = 0;
            } catch (e) {
                if (e instanceof TerminalApiError) {
                    console.error(`[Lumos] Terminal API Error during Calendar Indexing. Circuit breaking:`, e);
                    new Notice(`🚨 Calendar Indexing Halted: ${e.message}`, 15000);
                    return; // Halt completely
                } else if (e instanceof TransientApiError && retryCount < 3) {
                    console.warn(`[Lumos] Transient API Error. Retrying (Attempt ${retryCount + 1})...`, e);
                    retryCount++;
                    const delay = 2000 * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Skip the rest, loop will pull the event again
                } else {
                    console.error(`[RelationPlugin] Failed to index calendar event ${event.summary}`, e);
                    retryCount = 0;
                    cursor++; // Move past poison pill event
                }
            }
            cursor++; // Move past processed event
        }
        
        if (processedCount > 0) {
        // await this.plugin.vectorStore.forceSave();
        await this.plugin.relationStore.forceSave();
            new Notice(`[LLM Relations] Indexed ${processedCount} calendar events!`);
            
            const leaves = this.plugin.app.workspace.getLeavesOfType(RELATION_VIEW_TYPE);
            for (const leaf of leaves) {
                if (leaf.view instanceof RelationSidebarView) {
                    leaf.view.render();
                }
            }
        }
    }
}
