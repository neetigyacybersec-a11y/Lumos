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

	async onload() {
		console.log('obsidian-relation-plugin loaded');
		await this.loadSettings();
		this.addSettingTab(new RelationSettingTab(this.app, this));

		this.registerView(
			RELATION_VIEW_TYPE,
			(leaf) => new RelationSidebarView(leaf, this)
		);

		this.addRibbonIcon('link', 'Open LLM Relations', () => {
			this.activateView();
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
		this.indexer = new BackgroundIndexer(this);

		this.app.workspace.onLayoutReady(() => {
			this.indexer.start();
		});

		this.watcher.onReady(async (file: TFile) => {
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
					if (firstEmbedding) {
						const similar = this.vectorStore.querySimilar(firstEmbedding, 3, file.path);
						if (similar.length > 0) {
							const candidates = similar.map(s => ({ path: s.filePath, text: s.text }));
							const prompt = this.relationExtractor.constructPrompt(file.path, parsed.cleanText, candidates);
							
							console.log(`[RelationPlugin] Asking LLM for relations...`);
							const extractedEdges = await this.relationExtractor.extractRelations(prompt, file.path);
							
							// Compute final scores
							const edges = extractedEdges.map(edge => {
								const targetFile = this.app.vault.getAbstractFileByPath(edge.target);
								if (!(targetFile instanceof TFile)) return edge;
								
								const simMatch = similar.find(s => s.filePath === edge.target);
								const cosine = simMatch ? simMatch.similarity : 0;
								
								edge.scores = this.scoringEngine.calculateOverallScore(file, targetFile, cosine, edge.confidence);
								return edge;
							});

							await this.relationStore.upsertEdges(file.path, edges);
							console.log(`[RelationPlugin] Extracted ${edges.length} edges for ${file.path}`, edges);
							
							// Process Backlinks
							await this.backlinkManager.processEdges(file, edges);

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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
