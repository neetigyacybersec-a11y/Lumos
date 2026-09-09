import { Logger } from './logger';
import { TFile, Notice } from 'obsidian';
import { IndexerHost } from './ports';
import { IndexFileFlow } from './indexing/indexFileFlow';
import { VaultFileInput } from './indexing/vaultFileInput';
import { CalendarInput } from './indexing/calendarInput';
import { readManifest, writeManifest, manifestNeedsRebuild } from './indexManifest';
import { RELATION_VIEW_TYPE, RelationSidebarView } from './sidebarView';
import { isPathIgnored, INDEXABLE_EXTENSIONS } from './utils';
import { IndexingProgressUI } from './progressUi';
import { fetchAllCalendarEvents } from './googleCalendar';
import { TerminalApiError, TransientApiError } from './llmService';


const FILE_WATCHDOG_MS = 120_000;

export class BackgroundIndexer {
    plugin: IndexerHost;
    queue: TFile[] = [];
    private _isProcessing: boolean = false;
    progressUi: IndexingProgressUI;
    totalFiles: number = 0;
    processedFiles: number = 0;
    /** Failed paths are ineligible for watcher-triggered requeues for this long. */
    failureCooldownMs: number = 10 * 60 * 1000;
    private lastFailureAt: Map<string, number> = new Map();
    private halted: boolean = false;
    /** Current model's embedding dimension, learned from the first embed of a run. */
    private embedDim: number | undefined = undefined;
    private flow: IndexFileFlow;

    constructor(plugin: IndexerHost) {
        this.plugin = plugin;
        this.progressUi = new IndexingProgressUI();
        this.flow = new IndexFileFlow(plugin);
    }

    get isRunning(): boolean {
        return this._isProcessing;
    }

    get progress(): { total: number; processed: number } {
        return { total: this.totalFiles, processed: this.processedFiles };
    }

    /**
     * Single command/queue seam: enqueues a file and owns the total/progress
     * bookkeeping and kick-off, so callers never touch @queue/@totalFiles/
     * @processedFiles directly. Returns whether the file was actually enqueued.
     */
    async enqueueAndRun(file: TFile, opts: { force?: boolean } = {}): Promise<boolean> {
        const added = this.enqueue(file, opts.force ?? false);
        if (!added) return false;
        if (!this._isProcessing) {
            this.totalFiles = this.queue.length;
            this.processedFiles = 0;
            this.processQueue();
        } else {
            this.totalFiles = Math.max(this.totalFiles + 1, this.queue.length);
        }
        return true;
    }

    /** Abandons any in-flight/queued work and resets all progress counters. */
    reset() {
        this.queue = [];
        this._isProcessing = false;
        this.totalFiles = 0;
        this.processedFiles = 0;
        this.halted = false;
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
        if (this._isProcessing) return;

        // The persisted index could not be read. NEVER treat this as "empty
        // vault" and silently rehash everything (a stash-burning full scan).
        // Tell the user; a rebuild happens only via the explicit command.
        if (this.plugin.vectorStore.loadFailed) {
            new Notice('Lumos: your saved index could not be loaded. Search will be empty until you run "Clear Index and Re-scan Vault".', 8000);
            return;
        }

        const manifest = await readManifest(this.plugin, this.plugin.app.vault.adapter);

        // A different embedding model or schema than the index was built with
        // is a non-blocking signal: inform, but do NOT auto-rehash. The user
        // runs the manual command if they want fresh vectors.
        if (manifestNeedsRebuild(manifest, this.plugin.settings.embeddingModelName)) {
            new Notice('Lumos: your index was built with a different embedding model/schema. Run "Clear Index and Re-scan Vault" to rebuild.', 8000);
        }

        const files = this.plugin.app.vault.getFiles();
        let added = 0;
        
        for (const file of files) {
            const ext = file.extension.toLowerCase();
            if (!INDEXABLE_EXTENSIONS.includes(ext)) continue;
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
        } else {
            // Nothing to index this run: record the index metadata so a later
            // change to the embedding model/schema is detected without a rehash.
            await writeManifest(this.plugin, this.plugin.app.vault.adapter, this.plugin.settings.embeddingModelName);
        }
        
        // After starting the queue for files, let's also fetch and index calendar events
        if (this.plugin.settings.googleSyncEnabled && this.plugin.settings.googleRefreshToken) {
            this.indexCalendarEvents();
        }
    }

    async processQueue() {
        if (this._isProcessing || this.queue.length === 0) return;
        this._isProcessing = true;
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
                Logger.error(`[Lumos] Abandoning ${file.path}:`, e);
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
            this._isProcessing = false;
            this.progressUi.hide();
            return;
        }

        // Clean up queue when fully processed
        this.queue = [];

        // Final forced save once everything is queued
        await this.plugin.relationStore.forceSave();

        // Record the index metadata (model, schema, plugin version) so a later
        // change to the embedding model/schema is detected without a rehash.
        await writeManifest(this.plugin, this.plugin.app.vault.adapter, this.plugin.settings.embeddingModelName);

        // Ensure profile file exists so the user knows where it is
        const path = this.plugin.settings.userProfilePath;
        if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
            await this.plugin.app.vault.create(path, "# AI User Profile\n\n*No profile insights have been extracted yet. Keep writing notes!*");
        }

        this.plugin.userProfileManager.resumeUpdates();
        await this.plugin.userProfileManager.flush();

        this._isProcessing = false;
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
        try {
            return await this.runWithRetry(async () => {
                const made = await this.indexFileAttempt(file);
                return made;
            });
        } catch (e) {
            if (e instanceof TerminalApiError) throw e; // halt propagates to the queue loop
            Logger.error(`[Lumos] Failed to index ${file.path}`, e);
            await this.plugin.vectorStore.upsert(file.path, []);
            this.markFailed(file.path);
            return false;
        }
    }

    /** Shared retry/backoff/circuit-break policy for every network path. */
    private async runWithRetry<T>(op: () => Promise<T>): Promise<T> {
        let retryCount = 0;
        while (true) {
            try {
                return await op();
            } catch (e) {
                if (e instanceof TerminalApiError) {
                    Logger.error(`[Lumos] Terminal API Error. Circuit breaking:`, e);
                    this.halted = true;
                    new Notice(`🚨 LLM Indexing Halted: ${e.message}`, 15000);
                    throw e;
                } else if (e instanceof TransientApiError && retryCount < 3) {
                    Logger.warn(`[Lumos] Transient API Error. Retrying (Attempt ${retryCount + 1})...`, e);
                    retryCount++;
                    const delay = 2000 * Math.pow(2, retryCount);
                    new Notice(`Network error, retrying in ${delay/1000}s...`, delay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw e;
            }
        }
    }

    private async indexFileAttempt(file: TFile): Promise<boolean> {
        const { madeNetworkCall, embedDim } = await this.flow.index(new VaultFileInput(this.plugin, file), this.embedDim);
        this.embedDim = embedDim;
        return madeNetworkCall;
    }

    async indexCalendarEvents() {
        if (!this.plugin.settings.googleSyncEnabled) return;
        
        const events = await fetchAllCalendarEvents(this.plugin);
        if (events.length === 0) return;
        
        let processedCount = 0;
        let cursor = 0;
        
        while (cursor < events.length) {
            const event = events[cursor];
            if (!event) {
                cursor++;
                continue;
            }

            try {
                await this.runWithRetry(async () => {
                    const { embedDim } = await this.flow.index(new CalendarInput(event), this.embedDim);
                    this.embedDim = embedDim;
                });
                processedCount++;

                await new Promise(resolve => setTimeout(resolve, 1500)); // Delay for rate limit
            } catch (e) {
                if (e instanceof TerminalApiError || this.halted) {
                    Logger.error(`[Lumos] Calendar Indexing halted:`, e);
                    return; // Halt completely
                } else {
                    Logger.error(`[Lumos] Failed to index calendar event ${event.summary}`, e);
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
