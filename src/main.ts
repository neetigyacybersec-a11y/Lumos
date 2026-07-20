import { Plugin, TFile, WorkspaceLeaf } from 'obsidian';
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
import { hashString } from './utils';
import { ScoringEngine } from './scoring';
import { VisionExtractor } from './vision';
import { LocalOcr } from './localOcr';
import { SEARCH_VIEW_TYPE, SemanticSearchView } from './searchView';
import { UserProfileManager } from './userProfile';
import { ChatView, CHAT_VIEW_TYPE } from './chatView';

export default class RelationPlugin extends Plugin {
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

	async onload() {
		console.log('obsidian-relation-plugin loaded');
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

		this.watcher = new Watcher(this.app);
		this.parser = new Parser(this.app);
		this.vectorStore = new VectorStore(this);
		await this.vectorStore.load();
		this.embeddingPipeline = new EmbeddingPipeline(this.settings);
		this.relationStore = new RelationStore(this);
		await this.relationStore.load();
		this.relationExtractor = new RelationExtractor(this.settings);
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

			const deleted = !(await this.app.vault.adapter.exists(file.path));
			if (deleted) {
				console.log(`[RelationPlugin] File deleted: ${file.path}`);
				await this.vectorStore.delete(file.path);
				await this.relationStore.deleteEdges(file.path);
			} else {
				const parsed = await this.parser.parse(file);
				console.log(`[RelationPlugin] File ready: ${file.path}`, parsed);
				
				const contentHash = hashString(parsed.cleanText);
				if (this.vectorStore.getFileHash(file.path) === contentHash) {
					console.log(`[RelationPlugin] Skipping ${file.path} as content hash matches.`);
					return;
				}

				// Process embeddings
				const chunks = this.embeddingPipeline.chunkText(parsed.cleanText);
				let firstEmbedding: number[] | null = null;
				let didExtract = false;
				
				try {
					const vectorChunks = await Promise.all(chunks.map(async (text, i) => {
						const embedding = await this.embeddingPipeline.embed(text);
						if (i === 0) firstEmbedding = embedding;
						return {
							id: `${file.path}#${i}`,
							filePath: file.path,
							text,
							embedding,
							contentHash
						};
					}));
					await this.vectorStore.upsert(file.path, vectorChunks);
					console.log(`[RelationPlugin] Saved ${vectorChunks.length} embeddings for ${file.path}`);
					
					// Run Relation Extraction if we have embeddings
					if (firstEmbedding && this.vectorStore.getFileCount() > 1) {
						const similar = this.vectorStore.querySimilar(firstEmbedding, 3, file.path);
						if (similar.length > 0) {
							didExtract = true;
							const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
							const prompt = this.relationExtractor.constructPrompt(file.path, parsed.cleanText, candidates);
							
							console.log(`[RelationPlugin] Asking LLM for relations...`);
							const { edges, profileInsights } = await this.relationExtractor.extractRelations(prompt, file.path);
							
							if (profileInsights) {
								await this.userProfileManager.addInsight(profileInsights);
							}
							
							// Compute final scores
							const scoredEdges = edges.map(edge => {
								const targetFile = this.app.vault.getAbstractFileByPath(edge.target);
								if (!(targetFile instanceof TFile)) return edge;
								
								const simMatch = similar.find(s => s.filePath === edge.target);
								const cosine = simMatch ? simMatch.similarity : 0;
								
								edge.scores = this.scoringEngine.calculateOverallScore(file, targetFile, cosine, edge.confidence);
								return edge;
							});

							await this.relationStore.upsertEdges(file.path, scoredEdges);
							console.log(`[RelationPlugin] Extracted ${scoredEdges.length} edges for ${file.path}`, scoredEdges);
							
							// Process Backlinks
							await this.backlinkManager.processEdges(file, scoredEdges);

							// Trigger re-render of the sidebar if it's open
							const leaves = this.app.workspace.getLeavesOfType(RELATION_VIEW_TYPE);
							for (const leaf of leaves) {
								if (leaf.view instanceof RelationSidebarView) {
									leaf.view.render();
								}
							}
						}
					}
				} catch (e) {
					console.error(`[RelationPlugin] Failed pipeline for ${file.path}`, e);
				}

				if (!didExtract) {
					await this.userProfileManager.addActivity(parsed.cleanText);
				}
			}
		});

		this.watcher.onRename(async (file: TFile, oldPath: string) => {
			console.log(`[RelationPlugin] File renamed from ${oldPath} to ${file.path}`);
			await this.vectorStore.renameFile(oldPath, file.path);
			await this.relationStore.renameFile(oldPath, file.path);
			this.activateView();
		});

		this.watcher.register();
	}

	async onunload() {
		console.log('obsidian-relation-plugin unloaded');
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
