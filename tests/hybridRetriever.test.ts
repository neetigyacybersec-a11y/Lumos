import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import { VectorStore } from '../src/vectorStore';
import { LexicalIndex } from '../src/search/lexicalIndex';
import { HybridRetriever, rrfFuse } from '../src/search/hybridRetriever';
import { Reranker, RerankBackend } from '../src/search/reranker';

function fakeEmbed(text: string): number[] {
	const v = new Array(8).fill(0);
	for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) / 1000;
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	return v.map((x) => x / norm);
}

interface World {
	retriever: HybridRetriever;
	vectorStore: VectorStore;
	lexical: LexicalIndex;
	embedSpy: ReturnType<typeof vi.fn>;
	rerankSpy: ReturnType<typeof vi.fn>;
	setRerankerBackend(backend: RerankBackend | null): void;
	settings: any;
}

async function makeWorld(settings?: Record<string, any>): Promise<World> {
	const embedSpy = vi.fn(async (t: string) => fakeEmbed(t));
	const rerankSpy = vi.fn(async (_q: string, docs: string[]) => docs.map(() => 0.5));
	let backend: RerankBackend | null = {
		load: async () => {},
		score: async (q: string, docs: string[]) => rerankSpy(q, docs),
	};

	const plugin: any = {
		settings: {
			enableHybridSearch: true,
			rerankerModel: 'off',
			rerankCandidates: 20,
			...settings,
		},
		embeddingPipeline: { embed: embedSpy },
		vectorStore: null as any,
	};

	const vectorStore = new VectorStore(plugin);
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
	const reranker = new Reranker(() => backend);
	const retriever = new HybridRetriever(plugin, lexical, reranker);

	return {
		retriever,
		vectorStore,
		lexical,
		embedSpy,
		rerankSpy,
		setRerankerBackend(b: RerankBackend | null) {
			backend = b;
		},
		settings: plugin.settings,
	};
}

beforeEach(() => {});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('rrfFuse', () => {
	it('ranks documents appearing in both lists above single-list hits', () => {
		const fused = rrfFuse([
			[{ filePath: 'a.md', text: 'x' }, { filePath: 'b.md', text: 'y' }],
			[{ filePath: 'b.md', text: 'y' }, { filePath: 'c.md', text: 'z' }],
		]);
		expect(fused[0].filePath).toBe('b.md'); // top of both lists
		expect(fused.map((f) => f.filePath)).toContain('a.md');
		expect(fused.map((f) => f.filePath)).toContain('c.md');
	});

	it('keeps the representative chunk from the highest-priority list', () => {
		const fused = rrfFuse([
			[{ filePath: 'a.md', text: 'dense-chunk' }],
			[{ filePath: 'a.md', text: 'lexical-chunk' }],
		]);
		expect(fused[0].text).toBe('dense-chunk');
	});

	it('handles empty lists', () => {
		expect(rrfFuse([[], []])).toEqual([]);
	});
});

describe('HybridRetriever', () => {
	it('finds exact identifiers via the lexical leg even when dense ranks them low', async () => {
		const w = await makeWorld();
		await w.vectorStore.upsert('incident.md', [
			{ id: 'incident.md#0', filePath: 'incident.md', text: 'postmortem for CVE-2024-3094 attack', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h1' },
		]);
		await w.vectorStore.upsert('cooking.md', [
			{ id: 'cooking.md#0', filePath: 'cooking.md', text: 'pasta recipes with tomato sauce', embedding: [0, 0.9, 0.9, 0.9, 0, 0, 0, 0], contentHash: 'h2' },
		]);

		// Query whose dense embedding is closer to cooking.md's direction than
		// incident.md's — only the lexical leg can rescue the exact match.
		const results = await w.retriever.retrieve({ query: 'CVE-2024-3094', topK: 2 });
		expect(results[0].filePath).toBe('incident.md');
	});

	it('excludes the source file from both legs', async () => {
		const w = await makeWorld();
		await w.vectorStore.upsert('self.md', [
			{ id: 'self.md#0', filePath: 'self.md', text: 'unique quantum flux terms here', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);
		await w.vectorStore.upsert('other.md', [
			{ id: 'other.md#0', filePath: 'other.md', text: 'quantum flux discussion continues', embedding: [0.9, 1, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);

		const results = await w.retriever.retrieve({
			queryVector: [1, 0, 0, 0, 0, 0, 0, 0],
			lexicalQuery: 'quantum flux',
			topK: 5,
			excludeFilePath: 'self.md',
		});
		expect(results.map((r) => r.filePath)).not.toContain('self.md');
		expect(results[0].filePath).toBe('other.md');
	});

	it('falls back to lexical-only results when the embedding backend is down', async () => {
		const w = await makeWorld();
		w.embedSpy.mockRejectedValue(new Error('Ollama down'));
		await w.vectorStore.upsert('a.md', [
			{ id: 'a.md#0', filePath: 'a.md', text: 'dragon lore and legends', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);

		const results = await w.retriever.retrieve({ query: 'dragon lore', topK: 5 });
		expect(results[0].filePath).toBe('a.md');
	});

	it('returns empty for empty queries', async () => {
		const w = await makeWorld();
		expect(await w.retriever.retrieve({ query: '', topK: 5 })).toEqual([]);
		expect(await w.retriever.retrieve({ query: '  ', topK: 5 })).toEqual([]);
	});

	it('reranks fused candidates when enabled and normalizes to 0..1', async () => {
		const w = await makeWorld({ rerankerModel: 'mini', rerankCandidates: 20 });
		await w.vectorStore.upsert('a.md', [
			{ id: 'a.md#0', filePath: 'a.md', text: 'alpha doc', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);
		await w.vectorStore.upsert('b.md', [
			{ id: 'b.md#0', filePath: 'b.md', text: 'beta doc', embedding: [0, 1, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);
		// b.md wins the rerank stage
		w.rerankSpy.mockImplementation(async (_q: string, docs: string[]) =>
			docs.map((d) => (d === 'alpha doc' ? -2 : 3))
		);

		const results = await w.retriever.retrieve({ query: 'anything', topK: 2 });
		expect(w.rerankSpy).toHaveBeenCalled();
		expect(results[0].filePath).toBe('b.md');
		for (const r of results.slice(0, 2)) {
			expect(r.similarity).toBeGreaterThan(0);
			expect(r.similarity).toBeLessThanOrEqual(1);
		}
	});

	it('degrades to RRF ranking when the reranker fails', async () => {
		const w = await makeWorld({ rerankerModel: 'tiny' });
		w.setRerankerBackend(null);
		await w.vectorStore.upsert('a.md', [
			{ id: 'a.md#0', filePath: 'a.md', text: 'some content words', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);

		const results = await w.retriever.retrieve({ query: 'content words', topK: 5 });
		expect(results[0].filePath).toBe('a.md');
		expect(results[0].similarity).toBeCloseTo(1); // normalized RRF top score
	});

	it('lexical leg flips the ranking on exact-term matches (toggleable)', async () => {
		const setup = async () => {
			const w = await makeWorld();
			// Text matches the query exactly; dense embedding points elsewhere.
			await w.vectorStore.upsert('kubernetes.md', [
				{ id: 'kubernetes.md#0', filePath: 'kubernetes.md', text: 'kubernetes autoscaling guide', embedding: [0.7, 0.7, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
			]);
			// No term overlap; dense embedding happens to align with the query.
			await w.vectorStore.upsert('unrelated.md', [
				{ id: 'unrelated.md#0', filePath: 'unrelated.md', text: 'gardening soil tips', embedding: [0, 0, 0, 0, 0, 0, 0.4, 0.9], contentHash: 'h' },
			]);
			w.embedSpy.mockResolvedValue([0, 0, 0, 0, 0, 0, 0.3, 0.95]);
			return w;
		};

		const on = await setup();
		const hybridOn = await on.retriever.retrieve({ query: 'kubernetes autoscaling', topK: 2 });
		expect(hybridOn[0].filePath).toBe('kubernetes.md');

		const off = await makeWorld({ enableHybridSearch: false });
		// rebuild same corpus without the lexical leg
		await off.vectorStore.upsert('kubernetes.md', [
			{ id: 'kubernetes.md#0', filePath: 'kubernetes.md', text: 'kubernetes autoscaling guide', embedding: [0.7, 0.7, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);
		await off.vectorStore.upsert('unrelated.md', [
			{ id: 'unrelated.md#0', filePath: 'unrelated.md', text: 'gardening soil tips', embedding: [0, 0, 0, 0, 0, 0, 0.4, 0.9], contentHash: 'h' },
		]);
		off.embedSpy.mockResolvedValue([0, 0, 0, 0, 0, 0, 0.3, 0.95]);

		const hybridOff = await off.retriever.retrieve({ query: 'kubernetes autoscaling', topK: 2 });
		expect(hybridOff[0].filePath).toBe('unrelated.md'); // dense-only keeps the wrong winner
	});

	it('skipRerank: background indexing path never invokes the reranker', async () => {
		const w = await makeWorld({ rerankerModel: 'mini', rerankCandidates: 20 });
		w.vectorStore.onMutation?.('upsert', 'a.md', undefined, [
			{ id: 'a.md#0', filePath: 'a.md', text: 'alpha content', embedding: [1, 0, 0, 0, 0, 0, 0, 0], contentHash: 'h' },
		]);

		const results = await w.retriever.retrieve({
			queryVector: [1, 0, 0, 0, 0, 0, 0, 0],
			lexicalQuery: 'alpha content',
			topK: 3,
			excludeFilePath: 'self.md',
			skipRerank: true,
		});

		expect(w.rerankSpy).not.toHaveBeenCalled();
		expect(results[0].filePath).toBe('a.md');
	});
});
