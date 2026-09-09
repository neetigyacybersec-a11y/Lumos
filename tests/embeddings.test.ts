import { describe, it, expect, vi } from 'vitest';
import { VectorStore, cosineSimilarity } from '../src/vectorStore';
import { EmbeddingPipeline } from '../src/embeddings';
import { LLMTransport } from '../src/llm/transport';

describe('VectorStore and Embeddings', () => {
	it('calculates cosine similarity correctly', () => {
		const a = [1, 0, 0];
		const b = [1, 0, 0];
		const c = [0, 1, 0];
		
		expect(cosineSimilarity(a, b)).toBeCloseTo(1);
		expect(cosineSimilarity(a, c)).toBeCloseTo(0);
	});

	it('chunks text into sizes roughly bound by token limits', () => {
		const pipeline = new EmbeddingPipeline({} as LLMTransport);
		
		const text = "Para 1\n\nPara 2\n\nPara 3\n\nPara 4";
		// Force small token size to trigger multiple chunks
		const chunks = pipeline.chunkText(text, 2); 
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('keeps headings at the start of a new chunk (structure-aware)', () => {
		const pipeline = new EmbeddingPipeline({} as LLMTransport);
		const text = "Intro paragraph with a fair amount of body text.\n\n# Topic A\n\nContent for A.\n\n# Topic B\n\nContent for B.";
		const chunks = pipeline.chunkText(text, 2);
		// Every chunk that starts with a heading must begin exactly at that heading.
		for (const c of chunks) {
			if (c.startsWith('#')) {
				expect(/^# Topic [AB]/.test(c.split('\n')[0])).toBe(true);
			}
		}
		// Headed topics are never merged with each other.
		const headed = chunks.filter(c => c.startsWith('#'));
		expect(headed.length).toBeGreaterThanOrEqual(2);
	});

	it('splits an oversized single paragraph so no chunk exceeds the char cap', () => {
		const pipeline = new EmbeddingPipeline({} as LLMTransport);
		const longPara = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' '); // ~1100 chars
		const chunks = pipeline.chunkText(longPara, 8); // 32-char cap
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
	});

	it('getFileHash returns the single authoritative meta contentHash, independent of per-chunk hashes', async () => {
		const mockAdapter = {
			read: vi.fn().mockResolvedValue('[]'),
			write: vi.fn().mockResolvedValue(undefined)
		};
		const mockPlugin = {
			manifest: { dir: 'test' },
			app: { vault: { adapter: mockAdapter } }
		} as any;

		const store = new VectorStore(mockPlugin);
		await store.load();

		// Two chunks sharing a file-level contentHash via their first chunk.
		await store.upsert('a.md', [
			{ id: 'a#0', filePath: 'a.md', text: 'x', embedding: [1], contentHash: 'FILEHASH' },
			{ id: 'a#1', filePath: 'a.md', text: 'y', embedding: [1], contentHash: 'OTHER' }
		]);
		// Deterministic: always the meta row's value, regardless of which chunk
		// appears first in internal storage.
		expect(store.getFileHash('a.md')).toBe('FILEHASH');

		// Empty/failed file: upsert(path, []) still yields a stable row and no hash.
		await store.upsert('empty.md', []);
		expect(store.hasFile('empty.md')).toBe(true);
		expect(store.getFileHash('empty.md')).toBeUndefined();

		// Re-upserting a file refreshes the meta hash (no stale value).
		await store.upsert('a.md', [
			{ id: 'a#0', filePath: 'a.md', text: 'x', embedding: [1], contentHash: 'FILEHASH2' }
		]);
		expect(store.getFileHash('a.md')).toBe('FILEHASH2');
	});

	it('vector store handles upsert and query correctly', async () => {
		const mockAdapter = {
			read: vi.fn().mockResolvedValue('[]'),
			write: vi.fn().mockResolvedValue(undefined)
		};
		const mockPlugin = {
			manifest: { dir: 'test' },
			app: { vault: { adapter: mockAdapter } }
		} as any;

		const store = new VectorStore(mockPlugin);
		await store.load();

		await store.upsert('1.md', [
			{ id: '1#0', filePath: '1.md', text: 'cat', embedding: [1, 0, 0] }
		]);
		await store.upsert('2.md', [
			{ id: '2#0', filePath: '2.md', text: 'dog', embedding: [0.9, 0.1, 0] }
		]);
		await store.upsert('3.md', [
			{ id: '3#0', filePath: '3.md', text: 'car', embedding: [0, 1, 0] }
		]);

		const results = await store.querySimilar([1, 0, 0], 2);
		expect(results).toHaveLength(2);
		expect(results[0].filePath).toBe('1.md'); // Perfect match
		expect(results[1].filePath).toBe('2.md'); // Close match

		// Update removes old chunks
		await store.upsert('1.md', [
			{ id: '1#0', filePath: '1.md', text: 'feline', embedding: [0.8, 0.2, 0] },
			{ id: '1#1', filePath: '1.md', text: 'meow', embedding: [0.8, 0.2, 0] }
		]);
		
		const allFor1 = (await store.querySimilar([0.8, 0.2, 0], 5)).filter(x => x.filePath === '1.md');
		expect(allFor1).toHaveLength(1); // querySimilar now returns unique files, so we only get the best chunk for 1.md

		// Delete
		await store.delete('1.md');
		const remaining = await store.querySimilar([1, 0, 0], 5);
		expect(remaining.find(x => x.filePath === '1.md')).toBeUndefined();
	});
});
