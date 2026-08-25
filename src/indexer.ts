import { Logger } from './logger';
import { TFile, Notice } from 'obsidian';
import LumosPlugin from './main';
import { RELATION_VIEW_TYPE, RelationSidebarView } from './sidebarView';
import { hashString, isPathIgnored } from './utils';
import { IndexingProgressUI } from './progressUi';
import { fetchAllCalendarEvents, GoogleEvent } from './googleCalendar';
import { TerminalApiError, TransientApiError } from './llmService';


const FILE_WATCHDOG_MS = 120_000;

export class BackgroundIndexer {
    plugin: LumosPlugin;
    queue: TFile[] = [];
    isProcessing: boolean = false;
    progressUi: IndexingProgressUI;
    totalFiles: number = 0;
    processedFiles: number = 0;
    /** Failed paths are ineligible for watcher-triggered requeues for this long. */
    failureCooldownMs: number = 10 * 60 * 1000;
    private lastFailureAt: Map<string, number> = new Map();
    private halted: boolean = false;

    constructor(plugin: LumosPlugin) {
        this.plugin = plugin;
        this.progressUi = new IndexingProgressUI();
    }

    /**
     * Watcher/user entry point: de-duplicates pending entries and refuses to
     * requeue recently-failed files, so a crashing file cannot hot-loop the
     * queue through modify events.
     */
    enqueue(file: TFile, force: boolean = false): boolean {
        if (this.queue.some(f => f.path === file.path)) return false;
        if (!force) {
            const failedAt = this.lastFailureAt.get(file.path);
            if (failedAt !== undefined && Date.now() - failedAt < this.failureCooldownMs) {
                return false;
            }
        } else {
            this.lastFailureAt.delete(file.path);
        }
        this.queue.push(file);
        return true;
    }

    markFailed(path: string) {
        this.lastFailureAt.set(path, Date.now());
    }

    clearFailure(path: string) {
        this.lastFailureAt.delete(path);
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
            }
        }

        if (this.queue.length > 0) {
            this.totalFiles = this.queue.length;
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
        this.halted = false;
        this.plugin.userProfileManager.pauseUpdates();

        let cursor = 0;

        while (cursor < this.queue.length && !this.halted) {
            const file = this.queue[cursor];
            if (!file) {
                cursor++;
                continue;
            }

            let madeNetworkCall = false;
            let wdTimer: ReturnType<typeof setTimeout> | null = null;
            try {
                // A single hung await (parse, network, model) must never freeze
                // the whole run: race the file against a hard watchdog and
                // abandon it if it loses.
                madeNetworkCall = await Promise.race([
                    this.processFile(file),
                    new Promise<never>((_, reject) => {
                        wdTimer = setTimeout(
                            () => reject(new Error(`watchdog: exceeded ${FILE_WATCHDOG_MS / 1000}s`)),
                            FILE_WATCHDOG_MS
                        );
                    }),
                ]);
            } catch (e) {
                Logger.error(`[RelationPlugin] Abandoning ${file.path}:`, e);
                await this.plugin.vectorStore.upsert(file.path, []);
                this.markFailed(file.path);
            } finally {
                if (wdTimer) clearTimeout(wdTimer);
            }

            if (this.halted) break;

            this.processedFiles++;
            this.progressUi.update(this.processedFiles, this.totalFiles, file.name);
            cursor++;

            // Sleep a bit to avoid hitting rate limits, but ONLY if we actually made a network call
            if (madeNetworkCall) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        if (this.halted) {
            // Preserve the remaining queue (current file included) for next time,
            // exactly like the pre-watchdog circuit-break behaviour.
            this.queue = this.queue.slice(cursor);
            this.isProcessing = false;
            this.progressUi.hide();
            return;
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

    /**
     * Processes one file to completion (including transient retries). Returns
     * whether any network call was made. Terminal failures set this.halted.
     */
    private async processFile(file: TFile): Promise<boolean> {
        let madeNetworkCall = false;
        let retryCount = 0;

        while (true) {
            try {
                // Check if file was somehow deleted while waiting
                if (!(await this.plugin.app.vault.adapter.exists(file.path))) {
                    return madeNetworkCall;
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
                        Logger.error(`Failed to parse PDF ${file.path}`, e);
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
                        Logger.error(`Failed OCR on Image ${file.path}`, e);
                        shouldSkip = true;
                    }
                }

                if (shouldSkip || !cleanText || cleanText.trim() === '') {
                    // Mark as indexed with 0 chunks so we don't process it on every startup
                    await this.plugin.vectorStore.upsert(file.path, []);
                    return madeNetworkCall;
                }

                const contentHash = hashString(cleanText);
                if (this.plugin.vectorStore.getFileHash(file.path) === contentHash) {
                    Logger.info(`[Lumos] Skipping ${file.path} as content hash matches.`);
                    return madeNetworkCall;
                }

                // Embed only new/changed chunks; reuse stored vectors for
                // chunks whose text is unchanged (#incremental-edit).
                const previousChunks = this.plugin.vectorStore.getChunks(file.path);
                const reusable = new Map<string, number[]>();
                for (const prev of previousChunks) {
                    if (prev.chunkHash && prev.embedding.length > 0) {
                        reusable.set(prev.chunkHash, prev.embedding);
                    }
                }
                const isPartialUpdate = previousChunks.length > 0;

                const chunks = this.plugin.embeddingPipeline.chunkText(cleanText);
                let firstEmbedding: number[] | null = null;
                const changedChunkTexts: string[] = [];
                const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
                    const chunkHash = hashString(text);
                    let embedding = reusable.get(chunkHash);
                    if (!embedding) {
                        embedding = await this.plugin.embeddingPipeline.embed(text);
                        madeNetworkCall = true;
                        changedChunkTexts.push(text);
                    }
                    if (i === 0) firstEmbedding = embedding;
                    return { id: `${file.path}#${i}`, filePath: file.path, text, embedding, contentHash, chunkHash };
                }));
                await this.plugin.vectorStore.upsert(file.path, vectorChunks);

                // Extract Relations (only if it has similar notes to compare to)
                if (firstEmbedding && this.plugin.vectorStore.getFileCount() > 1) {
                    // Hybrid candidate selection: dense anchor embedding plus a
                    // BM25 query over the new/changed text. Reranking is a search
                    // feature only — never burn model inference per indexed file.
                    const lexicalQuery = (changedChunkTexts.length > 0
                        ? changedChunkTexts.join('\n\n')
                        : cleanText).slice(0, 4000);
                    const similar = await this.plugin.hybridRetriever.retrieve({
                        queryVector: firstEmbedding,
                        lexicalQuery,
                        topK: 3,
                        excludeFilePath: file.path,
                        skipRerank: true,
                    });
                    if (similar.length > 0) {
                        const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));

                        // On a partial edit, only send the changed excerpts to
                        // the LLM instead of the whole file (#incremental-edit).
                        const sourceText = isPartialUpdate
                            ? changedChunkTexts.join('\n\n')
                            : cleanText;
                        const prompt = this.plugin.relationExtractor.constructPrompt(file.path, sourceText, candidates);
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

                        // Keep relations discovered by unchanged chunks; the
                        // LLM only re-derives those touching changed text.
                        let finalEdges = scoredEdges;
                        if (isPartialUpdate) {
                            const existing = this.plugin.relationStore.getEdgesForPath(file.path)
                                .filter(e => e.source === file.path);
                            const superseded = new Set(scoredEdges.map(e => `${e.target}|${e.relationType}`));
                            const kept = existing.filter(e => !superseded.has(`${e.target}|${e.relationType}`));
                            finalEdges = [...kept, ...scoredEdges];
                        }

                        await this.plugin.relationStore.upsertEdges(file.path, finalEdges, true);

                        // Process Backlinks
                        if (ext === 'md') {
                            await this.plugin.backlinkManager.processEdges(file, finalEdges);
                        }
                    } else {
                        await this.plugin.userProfileManager.addActivity(cleanText);
                    }
                } else if (ext === 'md') {
                    await this.plugin.userProfileManager.addActivity(cleanText);
                }

                retryCount = 0; // Success
                return madeNetworkCall;
            } catch (e) {
                if (e instanceof TerminalApiError) {
                    Logger.error(`[Lumos] Terminal API Error. Circuit breaking:`, e);
                    this.halted = true;
                    new Notice(`🚨 LLM Indexing Halted: ${e.message}`, 15000);
                    return madeNetworkCall;
                } else if (e instanceof TransientApiError && retryCount < 3) {
                    Logger.warn(`[Lumos] Transient API Error. Retrying (Attempt ${retryCount + 1})...`, e);
                    retryCount++;
                    const delay = 2000 * Math.pow(2, retryCount);
                    new Notice(`Network error, retrying in ${delay/1000}s...`, delay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Retry the same file
                } else {
                    Logger.error(`[RelationPlugin] Failed to index ${file.path}`, e);
                    // Mark as processed with 0 chunks to prevent infinite poison-pill retry loops on startup
                    await this.plugin.vectorStore.upsert(file.path, []);
                    this.markFailed(file.path);
                    return madeNetworkCall;
                }
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
                    const similar = await this.plugin.hybridRetriever.retrieve({
                        queryVector: firstEmbedding,
                        lexicalQuery: cleanText.slice(0, 4000),
                        topK: 3,
                        excludeFilePath: virtualPath,
                        skipRerank: true,
                    });
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
                    Logger.error(`[Lumos] Terminal API Error during Calendar Indexing. Circuit breaking:`, e);
                    new Notice(`🚨 Calendar Indexing Halted: ${e.message}`, 15000);
                    return; // Halt completely
                } else if (e instanceof TransientApiError && retryCount < 3) {
                    Logger.warn(`[Lumos] Transient API Error. Retrying (Attempt ${retryCount + 1})...`, e);
                    retryCount++;
                    const delay = 2000 * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Skip the rest, loop will pull the event again
                } else {
                    Logger.error(`[RelationPlugin] Failed to index calendar event ${event.summary}`, e);
                    retryCount = 0;
                    // Removed cursor++ here to prevent double-increment
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
