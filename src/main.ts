import { Plugin, TFile, WorkspaceLeaf, MarkdownView, Notice } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from './types';
import { RelationSettingTab } from './settings';
import { Watcher } from './watcher';
import { Parser } from './parser';
import { VectorStore } from './vectorStore';
import { EmbeddingPipeline } from './embeddings';

import { RelationStore } from './relationStore';
import { RelationExtractor } from './relations';
import { RelationSidebarView, RELATION_VIEW_TYPE } from './sidebarView';
import { BackgroundIndexer } from './indexer';
import { BacklinkManager } from './backlinker';
import { hashString, isPathIgnored } from './utils';
import { ScoringEngine } from './scoring';
import { VisionExtractor } from './vision';
import { LocalOcr } from './localOcr';
import { SEARCH_VIEW_TYPE, SemanticSearchView } from './searchView';
import { UserProfileManager } from './userProfile';
import { ChatView, CHAT_VIEW_TYPE } from './chatView';
import { LLMService } from './llmService';

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

	async onload() {
		console.log('lumos loaded');
		await this.loadSettings();
		this.addSettingTab(new RelationSettingTab(this.app, this));

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
				this.indexer.queue = [];
				this.indexer.isProcessing = false;
				await this.indexer.start();
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
					const beautifiedText = await this.llmService.beautifyText(text);
					if (beautifiedText && beautifiedText.trim()) {
						editor.setValue(beautifiedText);
						new Notice('Page beautified!');
					} else {
						new Notice('Failed to beautify: LLM returned empty text.');
					}
				} catch (e) {
					console.error('[Lumos] Beautify failed', e);
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
					console.error('[Lumos] Auto-tag failed', e);
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
                        const similar = await this.vectorStore.querySimilar(embedding, 30);
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
					console.error('[Lumos] Auto-link command failed', e);
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
					console.error('[Lumos] Extract action items failed', e);
					new Notice('Failed to extract action items. Check console.');
				}
			}
		});

		this.watcher = new Watcher(this.app);
		this.parser = new Parser(this.app);
		this.llmService = new LLMService(this);
		this.vectorStore = new VectorStore(this);
		await this.vectorStore.load();
		this.embeddingPipeline = new EmbeddingPipeline(this.settings);
		this.relationStore = new RelationStore(this);
		await this.relationStore.load();
		this.relationExtractor = new RelationExtractor(this);
		this.backlinkManager = new BacklinkManager(this.app, this.settings);
		this.scoringEngine = new ScoringEngine(this.app);
		this.visionExtractor = new VisionExtractor(this.app, this.settings);
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
				this.indexer.queue.push(file);
				if (!this.indexer.isProcessing) {
					this.indexer.totalFiles = 1;
					this.indexer.processedFiles = 0;
					this.indexer.processQueue();
				} else {
					this.indexer.totalFiles++;
				}
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
		console.log('lumos unloaded');
		this.watcher.unregister();
		this.app.workspace.detachLeavesOfType(RELATION_VIEW_TYPE);
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
	}
}
