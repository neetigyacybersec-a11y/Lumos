import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import { BackgroundIndexer } from '../src/indexer';
import { VectorStore, VectorChunk } from '../src/vectorStore';
import { EmbeddingPipeline } from '../src/embeddings';
import { RelationExtractor } from '../src/relations';
import { TransientApiError } from '../src/llmService';
import { DEFAULT_SETTINGS, PluginSettings } from '../src/types';
import { LexicalIndex } from '../src/search/lexicalIndex';
import { HybridRetriever } from '../src/search/hybridRetriever';
import { Reranker } from '../src/search/reranker';

// ---------------------------------------------------------------------------
// Fake IndexedDB: persists rows in a module-level Map so a "restart" (new
// VectorStore instance + load()) sees exactly what the previous session wrote.
// ---------------------------------------------------------------------------

type Row = VectorChunk & { filePath: string };
const sharedRows = new Map<string, Row>();

function installFakeIDB() {
	(globalThis as any).indexedDB = {
		open(_name: string, _version: number) {
			const req: any = {};
			queueMicrotask(() => {
				req.result = makeDB();
				req.onsuccess && req.onsuccess();
			});
			return req;
		},
	};
}

function makeDB(): any {
	return {
		objectStoreNames: { contains: () => true },
		close() {},
		transaction(_store: string, _mode: string) {
			const pending: Array<() => void> = [];
			const tx: any = { oncomplete: null as any, onerror: null as any };
			const mkReq = (exec: () => any) => {
				const req: any = {};
				pending.push(() => {
					try {
						req.result = exec();
						req.onsuccess && req.onsuccess();
					} catch (e) {
						req.error = e;
						req.onerror && req.onerror();
					}
				});
				return req;
			};
			tx.objectStore = (_n: string) => ({
				getAll: () => mkReq(() => [...sharedRows.values()]),
				index: (_i: string) => ({
					getAllKeys: (fp: string) =>
						mkReq(() =>
							[...sharedRows.entries()].filter(([, v]) => v.filePath === fp).map(([id]) => id)
						),
					getAll: (fp: string) =>
						mkReq(() => [...sharedRows.values()].filter((v) => v.filePath === fp)),
				}),
				delete: (id: string) => mkReq(() => sharedRows.delete(id)),
				put: (rec: any) => mkReq(() => sharedRows.set(rec.id, JSON.parse(JSON.stringify(rec)))),
				clear: () => mkReq(() => sharedRows.clear()),
			});
			queueMicrotask(() => {
				while (pending.length) pending.shift()!();
				queueMicrotask(() => tx.oncomplete && tx.oncomplete());
			});
			return tx;
		},
	};
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-embeddings + world builder
// ---------------------------------------------------------------------------

function fakeEmbed(text: string): number[] {
	const v = new Array(8).fill(0);
	for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) / 1000;
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	return v.map((x) => x / norm);
}

function para(seed: string, words = 350): string {
	return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ');
}

interface World {
	indexer: BackgroundIndexer;
	vectorStore: VectorStore;
	counters: { embed: number; llm: number; parse: number; prompts: string[] };
	files: Map<string, TFile>;
	contents: Map<string, string>;
	setRelationBehavior(fn: () => Promise<string>): void;
}

async function makeWorld(
	fileSpecs: Record<string, string>,
	settings?: Partial<PluginSettings>
): Promise<World> {
	const contents = new Map<string, string>(Object.entries(fileSpecs));
	const files = new Map<string, TFile>();
	for (const path of contents.keys()) {
		const f = new TFile() as any;
		f.path = path;
		f.name = path.split('/').pop();
		f.basename = f.name.replace(/\.[^/.]+$/, '');
		f.extension = path.split('.').pop();
		f.stat = { mtime: Date.now() };
		files.set(path, f);
	}

	const counters = { embed: 0, llm: 0, parse: 0, prompts: [] as string[] };
	let relationBehavior: () => Promise<string> = async () =>
		'{"relations": [], "profileInsights": null}';

	const plugin: any = {
		app: {
			vault: {
				getFiles: () => [...files.values()],
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
				read: async (f: TFile) => contents.get(f.path) ?? '',
				create: async (p: string, c: string) => {
					contents.set(p, c);
				},
				on: vi.fn(),
				offref: vi.fn(),
				adapter: { exists: async (p: string) => contents.has(p) },
			},
			metadataCache: { getFileCache: () => null },
			workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: any) => cb() },
		},
		settings: { ...DEFAULT_SETTINGS, ...settings },
		manifest: {},
		logActivity: () => {},
		parser: {
			parse: async (f: TFile) => {
				counters.parse++;
				return {
					cleanText: contents.get(f.path) ?? '',
					wikilinks: [],
					tags: [],
				};
			},
		},
		vectorStore: null as any,
		embeddingPipeline: null as any,
		llmService: {
			callLLM: vi.fn(async (messages: any[]) => {
				counters.llm++;
				counters.prompts.push(messages[0].content);
				return relationBehavior();
			}),
		},
		relationStore: {
			upsertEdges: async () => {},
			forceSave: async () => {},
			deleteEdges: async () => {},
		},
		userProfileManager: {
			pauseUpdates: () => {},
			resumeUpdates: () => {},
			flush: async () => {},
			addInsight: async () => {},
			addActivity: async () => {},
		},
		backlinkManager: { processEdges: async () => {} },
		scoringEngine: {
			calculateOverallScore: () => ({ overall: 1, llm: 1, cosine: 0, keyword: 0, folder: 0, recency: 0 }),
		},
		localOcr: { hasText: async () => false },
		visionExtractor: { extractImageText: async () => '' },
	};

	plugin.relationExtractor = new RelationExtractor(plugin);

	const embeddingPipeline = new EmbeddingPipeline(plugin.settings);
	(embeddingPipeline as any).embed = async (text: string) => {
		counters.embed++;
		return fakeEmbed(text);
	};
	plugin.embeddingPipeline = embeddingPipeline;

	installFakeIDB();
	const vectorStore = new VectorStore(plugin);
	await vectorStore.load();
	plugin.vectorStore = vectorStore;

	const lexical = new LexicalIndex();
	vectorStore.onMutation = (op, filePath, oldPath, chunks) => {
		if (op === 'upsert' && filePath && chunks) {
			lexical.upsert(filePath, chunks.filter((c) => c.embedding.length > 0));
		} else if (op === 'delete' && filePath) {
			lexical.delete(filePath);
		} else if (op === 'rename' && filePath && oldPath) {
			lexical.renameFile(oldPath, filePath);
		} else if (op === 'clear') {
			lexical.clear();
		}
	};
	plugin.hybridRetriever = new HybridRetriever(plugin, lexical, new Reranker(null));

	const indexer = new BackgroundIndexer(plugin);
	(indexer as any).progressUi = { show() {}, update() {}, hide() {} };

	return {
		indexer,
		vectorStore,
		counters,
		files,
		contents,
		setRelationBehavior(fn: () => Promise<string>) {
			relationBehavior = fn;
		},
	};
}

async function drain(indexer: BackgroundIndexer) {
	await indexer.start();
	while ((indexer as any).isProcessing) {
		await new Promise((r) => setImmediate(r));
	}
}

// Cap every timer at 5ms so the 1.5s rate-limit sleeps and retry backoffs
// don't slow the loop down.
const realSetTimeout = global.setTimeout;
beforeEach(() => {
	sharedRows.clear();
	vi.stubGlobal(
		'setTimeout',
		((fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, Math.min(ms ?? 0, 5), ...a)) as any
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Symptom 1: files re-indexed on every Obsidian startup
// ---------------------------------------------------------------------------

describe('startup re-index cost', () => {
	it('healthy vault: second startup re-queues nothing and spends zero network calls', async () => {
		const w1 = await makeWorld({
			'a.md': para('alpha'),
			'b.md': para('beta'),
		});
		await drain(w1.indexer);
		expect(w1.counters.embed).toBeGreaterThan(0); // sanity: first run does work

		// --- restart Obsidian ---
		const w2 = await makeWorld({
			'a.md': para('alpha'),
			'b.md': para('beta'),
		});
		await drain(w2.indexer);

		expect(w2.indexer.queue.length).toBe(0);
		expect(w2.counters.embed).toBe(0);
		expect(w2.counters.llm).toBe(0);
	});

	it('REGRESSION: a file whose embedding failed transiently must not be re-parsed, re-embedded and re-sent to the LLM on every subsequent startup', async () => {
		const specs = { 'a.md': para('alpha'), 'b.md': para('beta') };
		const w1 = await makeWorld(specs);
		// b.md's first embed attempt fails (e.g. Ollama busy / network blip during
		// the startup burst) — embeddings.ts throws a plain Error, which the
		// indexer treats as a permanent failure and marks the file with 0 chunks.
		let bEmbedAttempts = 0;
		const realEmbed = (w1 as any).indexer.plugin.embeddingPipeline.embed;
		(w1 as any).indexer.plugin.embeddingPipeline.embed = async (text: string) => {
			if (text.includes('beta')) {
				bEmbedAttempts++;
				if (bEmbedAttempts <= 4) throw new Error('Ollama embedding failed');
			}
			return realEmbed(text);
		};
		await drain(w1.indexer);
		// b.md was poisoned: marked indexed with zero real chunks (marker row only).
		// The per-file #meta row and the marker row both carry empty embeddings.
		expect(w1.vectorStore.hasFile('b.md')).toBe(true);
		const bRows = w1.vectorStore.vectors.filter((v) => v.filePath === 'b.md');
		expect(bRows.filter((r) => r.id.endsWith('#meta'))).toHaveLength(1);
		expect(bRows.filter((r) => !r.id.endsWith('#meta'))).toHaveLength(1);
		expect(bRows.every((r) => r.embedding.length === 0)).toBe(true);

		// --- restart Obsidian ---
		const w2 = await makeWorld(specs);
		await drain(w2.indexer);

		expect(w2.counters.parse).toBeLessThanOrEqual(1); // only a.md is re-parsed at most
		expect(w2.counters.embed).toBe(0);
		expect(w2.counters.llm).toBe(0);
	});

	it('REGRESSION: an empty-content file marked as indexed must not be re-parsed on every restart', async () => {
		const specs = { 'a.md': para('alpha'), 'empty.md': '   ' };
		const w1 = await makeWorld(specs);
		await drain(w1.indexer);
		expect(w1.vectorStore.hasFile('empty.md')).toBe(true);
		const parsesAfterFirstRun = w1.counters.parse;

		const w2 = await makeWorld(specs);
		await drain(w2.indexer);

		expect(w2.counters.parse).toBe(0); // nothing re-parsed on second boot
		expect(parsesAfterFirstRun).toBe(2); // sanity: each file parsed exactly once in run 1
		expect(w2.counters.embed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Resilience: hangs, watchdogs, and failure cooldowns
// ---------------------------------------------------------------------------

describe('indexer resilience', () => {
	it('REGRESSION: a hung embedding call cannot freeze the whole queue', async () => {
		const specs = { 'a.md': para('alpha'), 'b.md': para('beta') };
		const w1 = await makeWorld(specs);
		w1.setRelationBehavior(async () => '{"relations": [], "profileInsights": null}');

		// b.md's embed hangs forever (backend accepted the socket, never replied)
		const realEmbed = w1.vectorStore.plugin.embeddingPipeline.embed;
		(w1.vectorStore.plugin.embeddingPipeline as any).embed = (text: string) =>
			text.includes('beta') ? new Promise<number[]>(() => {}) : realEmbed.call(w1.vectorStore.plugin.embeddingPipeline, text);

		await drain(w1.indexer); // must complete, not hang

		expect(w1.vectorStore.hasFile('a.md')).toBe(true);
		// b.md ended up marked failed rather than blocking everyone forever
		expect(w1.counters.parse).toBeGreaterThanOrEqual(2);
	});

	it('REGRESSION: a hung parser cannot freeze the whole queue', async () => {
		const specs = { 'a.md': para('alpha'), 'stuck.md': para('stuck') };
		const w1 = await makeWorld(specs);

		const realParse = (w1.vectorStore.plugin as any).parser.parse.bind((w1.vectorStore.plugin as any).parser);
		(w1.vectorStore.plugin.parser as any).parse = (f: TFile) =>
			f.path === 'stuck.md' ? new Promise<never>(() => {}) : realParse(f);

		await drain(w1.indexer); // watchdog must abandon stuck.md

		expect(w1.vectorStore.hasFile('a.md')).toBe(true);
	});

	it('REGRESSION: failed files cool down before the watcher can requeue them; duplicates dedupe', async () => {
		const specs = { 'a.md': para('alpha'), 'flaky.md': para('flaky') };
		const w1 = await makeWorld(specs);
		// flaky.md always fails at embed with a plain error -> generic poison path
		const realEmbed = w1.vectorStore.plugin.embeddingPipeline.embed;
		(w1.vectorStore.plugin.embeddingPipeline as any).embed = (text: string) => {
			if (text.includes('flaky')) return Promise.reject(new Error('boom'));
			return realEmbed.call(w1.vectorStore.plugin.embeddingPipeline, text);
		};
		await drain(w1.indexer);
		const parsesAfterFirstRun = w1.counters.parse;

		// Watcher fires again immediately -> cooldown must reject requeue
		const flakyFile = w1.files.get('flaky.md')!;
		expect(w1.indexer.enqueue(flakyFile)).toBe(false);
		expect(w1.indexer.queue.map((f) => f.path)).not.toContain('flaky.md');

		// Cooldown expiry allows it again
		w1.indexer.failureCooldownMs = 0;
		expect(w1.indexer.enqueue(flakyFile)).toBe(true);
		await drain(w1.indexer);
		expect(w1.counters.parse).toBeGreaterThan(parsesAfterFirstRun);

		// Dedup: same file twice while queued counts once
		const a = w1.files.get('a.md')!;
		w1.indexer.queue.length = 0;
		expect(w1.indexer.enqueue(a)).toBe(true);
		expect(w1.indexer.enqueue(a)).toBe(false);
		expect(w1.indexer.queue.filter((f) => f.path === 'a.md')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Symptom 2: small edit sends the whole file to the LLM/embedder
// ---------------------------------------------------------------------------

describe('incremental edit cost', () => {
	it('REGRESSION: editing one paragraph must not re-embed every chunk nor put the whole unchanged file in the LLM prompt', async () => {
		const chunkText = para('chunk', 420); // > ~500 tokens -> own chunk
		const bigFile = [para('intro'), '', chunkText, '', para('outro')].join('\n\n');
		const specs = { 'big.md': bigFile, 'other.md': para('other') };

		const w1 = await makeWorld(specs);
		await drain(w1.indexer);
		const chunksInFile = w1.vectorStore.vectors.filter((v) => v.filePath === 'big.md').length;
		expect(chunksInFile).toBeGreaterThanOrEqual(3); // sanity: file really is multi-chunk
		const embedsAfterFirstRun = w1.counters.embed;

		// --- user edits ONE word inside the middle chunk ---
		const editedChunk = chunkText.replace('chunk0', 'EDITED');
		w1.contents.set('big.md', bigFile.replace(chunkText, editedChunk));

		// watcher path: queue the modified file and process it
		w1.indexer.queue.push(w1.files.get('big.md')!);
		await drain(w1.indexer);

		const embedDelta = w1.counters.embed - embedsAfterFirstRun;

		// Ideal: only the changed chunk is re-embedded...
		expect(embedDelta).toBeLessThan(chunksInFile);
		// ...and the relation prompt must not carry the entire unchanged file.
		const lastPrompt = w1.counters.prompts[w1.counters.prompts.length - 1];
		expect(lastPrompt.length).toBeLessThan(bigFile.length);
	});
});
