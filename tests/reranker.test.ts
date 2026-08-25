import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HybridRetriever } from '../src/search/hybridRetriever';
import { LexicalIndex } from '../src/search/lexicalIndex';
import { Reranker, createBlobWorkerBackend } from '../src/search/reranker';

/**
 * Regression loop for: "reranker model never downloads".
 *
 * Root cause: Obsidian windows run at origin app://obsidian.md while plugin
 * resources live on a different app://<hash> origin; constructing a Worker
 * from the resource URL throws SecurityError, silently disabling reranking.
 *
 * Constraint encoded here: the Worker MUST be constructed from a same-origin
 * blob: URL wrapping the worker script text — never from the app:// URL.
 */

class SecurityError extends Error {}

let lastWorkerUrl: string | null = null;
let workerHandler: ((ev: { data: any }) => void) | null = null;
let createdWorkers: { messages: any[]; postMessage: (m: any) => void }[] = [];

class CrossOriginBlockingWorker {
    messages: any[] = [];
    constructor(url: string) {
        lastWorkerUrl = String(url);
        if (!String(url).startsWith('blob:')) {
            throw new SecurityError(
                `Failed to construct 'Worker': Script at '${url}' cannot be accessed from origin 'app://obsidian.md'.`
            );
        }
        // Blob workers work. Capture the message handler so the test can play worker.
        Object.defineProperty(this, 'onmessage', {
            set(fn: (ev: { data: any }) => void) {
                workerHandler = fn;
            },
            get() {
                return workerHandler;
            },
        });
        createdWorkers.push(this);
    }
    postMessage(msg: any) {
        this.messages.push(msg);
    }
    terminate() {}
}

function installFakeEnv() {
    (globalThis as any).Worker = CrossOriginBlockingWorker;
    (globalThis as any).Blob = class {
        parts: any[];
        constructor(parts: any[]) {
            this.parts = parts;
        }
    };
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:fake-worker-url');
}

describe('reranker worker spawning under Obsidian origins', () => {
    beforeEach(() => {
        lastWorkerUrl = null;
        workerHandler = null;
        createdWorkers = [];
        installFakeEnv();
    });
    afterEach(() => {
        delete (globalThis as any).Worker;
        delete (globalThis as any).Blob;
        delete (globalThis as any).URL.createObjectURL;
        vi.restoreAllMocks();
    });

    it('REGRESSION: spawns the worker from a blob URL, not the app:// resource URL', async () => {
        const SCRIPT = 'self.onmessage = () => {}; /* worker bundle */';
        const backend = createBlobWorkerBackend(SCRIPT);
        expect(backend).not.toBeNull();
        expect(lastWorkerUrl).toMatch(/^blob:/);
        expect(lastWorkerUrl).not.toMatch(/app:\/\//);
    });

    it('REGRESSION: enabled reranker completes a search end-to-end (load -> scores)', async () => {
        const SCRIPT = '/* bundle */';
        const backend = createBlobWorkerBackend(SCRIPT)!;
        const loadPromise = backend.load('Xenova/ms-marco-MiniLM-L-6-v2');

        return (async () => {
            // The manager wires onmessage synchronously during construction.
            expect(workerHandler).not.toBeNull();

            // Simulate worker confirming model load.
            workerHandler!({ data: { type: 'ready' } });
            await loadPromise;

            const scorePromise = backend.score('query', ['doc one', 'doc two']);
            // Answer the rerank request using the id the backend posted.
            const worker = createdWorkers[0];
            const rerankMsg = worker.messages.find((m) => m.type === 'rerank');
            expect(rerankMsg).toBeDefined();
            workerHandler!({
                data: { id: rerankMsg.id, type: 'scores', scores: [1.2, -3.4] },
            });
            const scores = await scorePromise;
            expect(scores).toHaveLength(2);
            expect(scores[0]).toBeGreaterThan(scores[1]); // raw logits preserved
        })();
    });

	it('end-to-end: hybrid retrieval uses the blob-spawned reranker', async () => {
		const backend = createBlobWorkerBackend('/* bundle */')!;
		let rerankCalls = 0;
		const loadedModels: string[] = [];
		const origLoad = backend.load.bind(backend);
		backend.load = async (modelId: string) => {
			loadedModels.push(modelId);
			await origLoad(modelId);
		};
		const origScore = backend.score.bind(backend);
		backend.score = async (q, docs) => {
			rerankCalls++;
			return docs.map(() => -1);
		};

		const embedSpy = vi.fn(async () => [1, 0, 0, 0, 0, 0, 0, 0]);
		const plugin: any = {
			settings: { enableHybridSearch: true, rerankerModel: 'mini', rerankCandidates: 20 },
			embeddingPipeline: { embed: embedSpy },
			vectorStore: {
				querySimilar: async () => [
					{ filePath: 'a.md', text: 'alpha', similarity: 0.9 },
				],
			},
		};
		const lexical = new LexicalIndex();
		lexical.upsert('a.md', [{ text: 'alpha' }]);
		const retriever = new HybridRetriever(plugin, lexical, new Reranker(() => backend));

		// Drive the load handshake out of band.
		setTimeout(() => workerHandler?.({ data: { type: 'ready' } }), 10);

		const results = await retriever.retrieve({ query: 'alpha', topK: 5 });
		expect(rerankCalls).toBeGreaterThan(0);
		// REGRESSION guard: the selected model key must reach the worker — a
		// dropped argument here silently loaded `undefined` and never ranked.
		expect(loadedModels).toEqual(['Xenova/ms-marco-MiniLM-L-6-v2']);
		expect(results[0].filePath).toBe('a.md');
		void origScore;
	});
});
