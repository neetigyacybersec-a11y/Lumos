import { Logger } from './logger';
import { Plugin, TFile, WorkspaceLeaf, MarkdownView, Notice } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from './types';
import { RelationSettingTab } from './settings';
import { Watcher } from './watcher';
import { Parser } from './parser';
import { VectorStore } from './vectorStore';
import { EmbeddingPipeline } from './embeddings';
import { createTransport, LLMTransport } from './llm/transport';

import { RelationStore } from './relationStore';
import { RelationExtractor } from './relations';
import { RelationSidebarView, RELATION_VIEW_TYPE } from './sidebarView';
import { BackgroundIndexer } from './indexer';
import { BacklinkManager } from './backlinker';
import { isPathIgnored } from './utils';
import { ScoringEngine } from './scoring';
import { VisionExtractor } from './vision';
import { LocalOcr } from './localOcr';
import { SEARCH_VIEW_TYPE, SemanticSearchView } from './searchView';
import { UserProfileManager } from './userProfile';
import { ChatView, CHAT_VIEW_TYPE } from './chatView';
import { LLMService } from './llmService';
import { MirroredIndex } from './search/mirroredIndex';
import { HybridRetriever } from './search/hybridRetriever';
import { Reranker, createBlobWorkerBackend, type RerankerProgress } from './search/reranker';
import { WORKER_SCRIPT } from './search/workerScript';
import { RagAnswerer } from './ragAnswer';
import { beautifyNote, BeautifyHost } from './beautify';

export default class LumosPlugin extends Plugin {
	settings: PluginSettings;
	watcher: Watcher;
	parser: Parser;
	vectorStore: VectorStore;
	embeddingPipeline: EmbeddingPipeline;
	relationStore: RelationStore;
	relationExtractor: RelationExtractor;
	indexer: BackgroundIndexer;
	backlinkManager: BacklinkManager;
	scoringEngine: ScoringEngine;
	visionExtractor: VisionExtractor;
	localOcr: LocalOcr;
	userProfileManager: UserProfileManager;
	llmService: LLMService;
	llmTransport: LLMTransport;
	lexicalIndex: MirroredIndex;
	hybridRetriever: HybridRetriever;
	ragAnswerer: RagAnswerer;

	public activityLog: string[] = [];
	private rerankerStatusEl: HTMLElement | null = null;

	logActivity(message: string) {
		const timestamp = new Date().toLocaleTimeString();
		this.activityLog.unshift(`[${timestamp}] ${message}`);
		if (this.activityLog.length > 50) this.activityLog.pop();
	}

	/** Renders local-reranker model download/load progress on the status bar. */
	private renderRerankerProgress(p: RerankerProgress) {
		const el = this.rerankerStatusEl;
		if (!el) return;
		const file = p.file ? p.file.split('/').pop() : '';
		if (p.status === 'ready') {
			el.setText('Lumos: reranker ready');
			el.show();
			setTimeout(() => el.hide(), 2500);
			return;
		}
		if (p.status === 'progress' || p.status === 'progress_total') {
			const pct = typeof p.percent === 'number' ? Math.round(p.percent) : 0;
			el.setText(file ? `Lumos: reranker ${pct}% (${file})` : `Lumos: reranker ${pct}%`);
			el.show();
			return;
		}
		if (p.status === 'download') {
			el.setText(file ? `Lumos: downloading reranker (${file})` : 'Lumos: downloading reranker...');
			el.show();
		} else if (p.status === 'done') {
			el.setText('Lumos: reranker model ready');
			el.show();
		}
	}

	async onload() {
		Logger.init(this);
		Logger.info('lumos loaded');
		await this.loadSettings();
		this.addSettingTab(new RelationSettingTab(this.app, this));

		// Persistent status surface for long-running background work (e.g. the
		// local reranker model download), hidden until there is something to show.
		this.rerankerStatusEl = this.addStatusBarItem();
		this.rerankerStatusEl.setText('');
		this.rerankerStatusEl.hide();

		this.registerView(
			RELATION_VIEW_TYPE,
			(leaf) => new RelationSidebarView(leaf, this)
		);
		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SemanticSearchView(leaf, this));
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon('link', 'LLM Relations', () => {
			this.activateView();
		});
		
		this.addRibbonIcon('search', 'Semantic Search', () => {
			this.activateSearchView();
		});

		this.addRibbonIcon('message-circle', 'AI Chat', () => {
			this.activateChatView();
		});

		this.addCommand({
			id: 'clear-llm-relations-index',
			name: 'Clear Index and Re-scan Vault',
			callback: async () => {
				// Clear the stores
				await this.vectorStore.clear();
				await this.relationStore.clear();

				// Re-run the indexer
				this.indexer.reset();
				await this.indexer.start();
			}
		});

		this.addCommand({
			id: 'force-reindex-current-file',
			name: 'Force Re-index Current File',
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice('No active file to re-index.');
					return;
				}
				new Notice(`Re-indexing ${file.name}...`);
				await this.vectorStore.delete(file.path);
				await this.relationStore.deleteEdges(file.path);
				this.indexer.clearFailure(file.path);
				await this.indexer.enqueueAndRun(file, { force: true });
			}
		});

		this.addCommand({
			id: 'retry-failed-files',
			name: 'Retry Failed/Empty Files',
			callback: async () => {
				const allFiles = Array.from(this.vectorStore.indexedFiles);
				const validFiles = new Set(this.vectorStore.vectors.filter(v => v.embedding.length > 0).map(v => v.filePath));
				const poisonedFiles = allFiles.filter(f => !validFiles.has(f));
				
				if (poisonedFiles.length === 0) {
					new Notice('No failed or empty files found in the index.');
					return;
				}

				let queued = 0;
				for (const filePath of poisonedFiles) {
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						await this.vectorStore.delete(filePath);
						await this.relationStore.deleteEdges(filePath);
						this.indexer.clearFailure(filePath);
						if (await this.indexer.enqueueAndRun(file, { force: true })) queued++;
					}
				}

				if (queued > 0) {
					new Notice(`Queued ${queued} failed/empty files for re-indexing.`);
				} else {
					new Notice('Could not find the actual files for the failed entries.');
				}
			}
		});

		this.addCommand({
			id: 'beautify-current-page',
			name: 'Beautify Current Page',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) {
					new Notice('No active Markdown view found.');
					return;
				}

				const editor = view.editor;
				const text = editor.getValue();
				if (!text.trim()) {
					new Notice('Page is empty.');
					return;
				}

				new Notice('Beautifying page...');
				try {
					const host: BeautifyHost = {
						resolveEmbed: (linkPath, sourcePath) =>
							this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath),
						transcribeImage: (file) => this.visionExtractor.extractImageText(file as TFile),
						retrieveRelated: (query, topK, excludeFilePath) =>
							this.hybridRetriever
								.retrieve({ query, topK, excludeFilePath })
								.then(results => results.map(r => ({ filePath: r.filePath, text: r.text }))),
						beautifyViaLLM: (payload, opts) =>
							this.llmService.beautifyText(payload, {
								relatedNotes: opts.relatedNotes,
								imageCaptions: opts.imageCaptions,
							}),
					};
					const beautifiedText = await beautifyNote(text, view.file.path, host, {
						relatedNotes: this.settings.beautifyAddRelatedNotes,
						imageCaptions: this.settings.beautifyAddImageCaptions,
						relatedTopK: this.settings.beautifyRelatedTopK,
					});
					if (beautifiedText && beautifiedText.trim()) {
						editor.setValue(beautifiedText);
						new Notice('Page beautified!');
					} else {
						new Notice('Failed to beautify: LLM returned empty text.');
					}
				} catch (e) {
					Logger.error('[Lumos] Beautify failed', e);
					new Notice('Failed to beautify page. Check console.');
				}
			}
		});

		this.addCommand({
			id: 'auto-tag-summarize',
			name: 'Auto-Tag & Summarize Note',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) {
					new Notice('No active Markdown view found.');
					return;
				}

				const text = view.editor.getValue();
				if (!text.trim()) {
					new Notice('Page is empty.');
					return;
				}

				new Notice('Analyzing note for tags and summary...');
				try {
					const metadata = await this.llmService.extractMetadata(text);
					if (metadata && metadata.tags && metadata.summary) {
						await this.app.fileManager.processFrontMatter(view.file, (frontmatter: any) => {
							if (!frontmatter['tags']) frontmatter['tags'] = [];
                            let existingTags = Array.isArray(frontmatter['tags']) ? frontmatter['tags'] : [frontmatter['tags']];
                            
                            for (const tag of metadata.tags) {
                                if (!existingTags.includes(tag)) {
                                    existingTags.push(tag);
                                }
                            }
                            frontmatter['tags'] = existingTags;
							frontmatter['description'] = metadata.summary;
						});
						new Notice('Note auto-tagged and summarized!');
					} else {
						new Notice('Failed to extract metadata.');
					}
				} catch (e) {
					Logger.error('[Lumos] Auto-tag failed', e);
					new Notice('Failed to auto-tag page. Check console.');
				}
			}
		});

		this.addCommand({
			id: 'auto-link-entities',
			name: 'Auto-Link Entities',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) {
					new Notice('No active Markdown view found.');
					return;
				}

				const editor = view.editor;
				const text = editor.getSelection() || editor.getValue();
				if (!text.trim()) {
					new Notice('Text is empty.');
					return;
				}

				new Notice('Auto-linking entities...');
				try {
					let vaultFiles: string[] = [];
                    const chunks = this.embeddingPipeline.chunkText(text);
                    if (chunks.length > 0) {
                        const embedding = await this.embeddingPipeline.embed(chunks[0]);
                        const similar = await this.hybridRetriever.retrieve({ queryVector: embedding, topK: 30 });
                        vaultFiles = similar.map(s => {
                            const f = this.app.vault.getAbstractFileByPath(s.filePath);
                            return f ? f.name.replace(/\.[^/.]+$/, "") : s.filePath;
                        });
                    }

                    vaultFiles = [...new Set(vaultFiles)];
                    
                    if (vaultFiles.length === 0) {
                        new Notice('No relevant vault files found for linking.');
                        return;
                    }

					const linkedText = await this.llmService.autoLinkText(text, vaultFiles);
					if (linkedText && linkedText.trim()) {
                        if (editor.getSelection()) {
                            editor.replaceSelection(linkedText);
                        } else {
                            editor.setValue(linkedText);
                        }
						new Notice('Entities auto-linked!');
					} else {
						new Notice('Failed to auto-link text.');
					}
				} catch (e) {
					Logger.error('[Lumos] Auto-link command failed', e);
					new Notice('Failed to auto-link page. Check console.');
				}
			}
		});

		this.addCommand({
			id: 'extract-action-items',
			name: 'Extract Action Items',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) {
					new Notice('No active Markdown view found.');
					return;
				}

				const editor = view.editor;
				const text = editor.getValue();
				if (!text.trim()) {
					new Notice('Page is empty.');
					return;
				}

				new Notice('Extracting action items...');
				try {
					const actionItems = await this.llmService.extractActionItems(text);
					if (actionItems && actionItems.trim() && actionItems.trim() !== 'NO_TASKS') {
						const lastLine = editor.lastLine();
                        const lastLineLength = editor.getLine(lastLine).length;
                        const appendText = `\n\n## Action Items\n${actionItems}`;
                        editor.replaceRange(appendText, { line: lastLine, ch: lastLineLength });
						new Notice('Action items appended!');
					} else if (actionItems && actionItems.trim() === 'NO_TASKS') {
						new Notice('No action items found in the text.');
					} else {
                        new Notice('Failed to extract action items.');
                    }
				} catch (e) {
					Logger.error('[Lumos] Extract action items failed', e);
					new Notice('Failed to extract action items. Check console.');
				}
			}
		});

		this.watcher = new Watcher(this);
		this.parser = new Parser(this.app);
		this.llmTransport = createTransport(this.settings);
		this.llmService = new LLMService(this.llmTransport);
		this.vectorStore = new VectorStore(this);
		await this.vectorStore.load();

		// Hybrid retrieval: BM25 index mirrors the vector corpus, RRF fusion,
		// optional local cross-encoder rerank (runs off the UI thread).
		this.lexicalIndex = new MirroredIndex();
		this.lexicalIndex.attach(this.vectorStore);
		const reranker = new Reranker(async () => {
			try {
				const dir = this.manifest?.dir || '';
				// Worker construction is cross-origin-blocked for app:// resource
				// URLs; spawn from a same-origin blob of the script text instead.
				//
				// Prefer the on-disk worker (kept fresh by `npm run dev` for local
				// development), then fall back to the copy inlined into main.js by
				// esbuild — the community installer ships only main.js, so the
				// worker source must travel inside it.
				let script: string | undefined;
				try {
					script = await this.app.vault.adapter.read(`${dir}/reranker.worker.js`);
				} catch {
					script = undefined;
				}
				return createBlobWorkerBackend(script ?? WORKER_SCRIPT);
			} catch (e) {
				Logger.warn('[Lumos] Reranker worker unavailable:', e);
				return null;
			}
		}, false, () => {
			this.rerankerStatusEl?.hide();
			new Notice('Lumos: local reranker unavailable this session — using rank fusion only.', 8000);
		}, (modelId) => {
			new Notice('Lumos: downloading local reranker model (one-time)...', 10000);
			Logger.info(`[Lumos] Downloading reranker model ${modelId}`);
		});
		reranker.onProgress = (p) => {
			this.renderRerankerProgress(p);
		};
		this.hybridRetriever = new HybridRetriever(this, this.lexicalIndex.lexical, reranker);
		this.ragAnswerer = new RagAnswerer(this);

		this.embeddingPipeline = new EmbeddingPipeline(this.llmTransport);
		this.relationStore = new RelationStore(this);
		await this.relationStore.load();
		this.relationExtractor = new RelationExtractor(this);
		this.backlinkManager = new BacklinkManager(this.app, this.settings);
		this.scoringEngine = new ScoringEngine(this.app);
		this.visionExtractor = new VisionExtractor(this.app, this.llmTransport);
		this.localOcr = new LocalOcr(this.app);
		this.userProfileManager = new UserProfileManager(this.app, this);
		
		this.indexer = new BackgroundIndexer(this);

		this.app.workspace.onLayoutReady(() => {
			this.indexer.start();
		});

		this.watcher.onReady(async (file: TFile) => {
			if (file.path === this.settings.userProfilePath) return;
			if (isPathIgnored(file.path, this.settings.ignoredFolders)) return;

			const deleted = !(await this.app.vault.adapter.exists(file.path));
			if (deleted) {
				await this.vectorStore.delete(file.path);
				await this.relationStore.deleteEdges(file.path);
			} else {
				await this.indexer.enqueueAndRun(file);
			}
		});

		this.watcher.onRename(async (file: TFile, oldPath: string) => {
			await this.vectorStore.renameFile(oldPath, file.path);
			await this.relationStore.renameFile(oldPath, file.path);
			this.activateView();
		});

		this.watcher.register();
	}

	async onunload() {
		Logger.info('lumos unloaded');
		this.watcher.unregister();
		this.app.workspace.detachLeavesOfType(RELATION_VIEW_TYPE);
		const { closeAuthServer } = require('./googleAuth');
		closeAuthServer();
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(RELATION_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: RELATION_VIEW_TYPE, active: true });
			}
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	async activateSearchView() {
		const { workspace } = this.app;
		
		let leaf = workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
		
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
				leaf = rightLeaf;
			}
		}
		
		if (leaf) workspace.revealLeaf(leaf);
	}

	async activateChatView() {
		const { workspace } = this.app;
		
		let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
				leaf = rightLeaf;
			}
		}
		
		if (leaf) workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.rebuildLLMTransport();
	}

	/** Rebuilds the shared transport from live settings and re-injects it so
	 *  provider/baseUrl/apiKey/model changes take effect without a restart. */
	rebuildLLMTransport() {
		this.llmTransport = createTransport(this.settings);
		this.llmService.transport = this.llmTransport;
		this.embeddingPipeline.transport = this.llmTransport;
		this.visionExtractor.transport = this.llmTransport;
	}
}
