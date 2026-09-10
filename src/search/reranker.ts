import { Logger } from '../logger';

export type RerankerModelKey = 'tiny' | 'mini';

export const RERANKER_MODEL_IDS: Record<RerankerModelKey, string> = {
    tiny: 'Xenova/ms-marco-TinyBERT-L-2-v2',
    mini: 'Xenova/ms-marco-MiniLM-L-6-v2',
};

export interface RerankBackend {
    load(modelId: string): Promise<void>;
    score(query: string, documents: string[]): Promise<number[]>;
    /** Optional hook the backend calls with download/load progress updates. */
    setOnLoadProgress?(cb?: (progress: RerankerProgress) => void): void;
}

/** Progress info relayed from the worker during model download/load. */
export type RerankerProgress = {
    status: string;
    file?: string;
    /** 0..100 percent when status is 'progress'/'progress_total', else null. */
    percent?: number | null;
    loaded?: number | null;
    total?: number | null;
};

/**
 * Main-thread handle over the ONNX cross-encoder running inside
 * reranker.worker.js. Any failure degrades permanently to null results so
 * retrieval falls back to plain RRF ranking.
 */
export class Reranker {
    private backend: RerankBackend | null = null;
    private loadedKey: string | null = null;
    private loadAttempts = 0;
    private failed = false;
    /** Attach from the host to observe download/load progress. */
    onProgress: ((progress: RerankerProgress) => void) | null = null;

    constructor(
        private createBackend?: (() => RerankBackend | null | Promise<RerankBackend | null>) | null,
        private allowInline: boolean = false,
        private onUnavailable?: () => void,
        private onModelLoad?: (modelId: string) => void
    ) {}

    private attachProgress(backend: RerankBackend) {
        if (typeof backend.setOnLoadProgress === 'function') {
            backend.setOnLoadProgress((p) => this.onProgress?.(p));
        }
    }

    async rerank(
        query: string,
        documents: string[],
        modelKey: RerankerModelKey
    ): Promise<number[] | null> {
        if (documents.length === 0) return [];
        if (this.failed) return null;
        try {
            if (!this.backend) {
                this.backend = this.createBackend ? await this.createBackend() : null;
                if (!this.backend && this.allowInline) {
                    this.backend = await createInlineBackend();
                }
                if (!this.backend) {
                    Logger.warn('[Lumos] Reranker enabled but no worker backend available.');
                    this.failed = true;
                    this.onUnavailable?.();
                    return null;
                }
                this.attachProgress(this.backend);
            }
            const modelId = RERANKER_MODEL_IDS[modelKey];
            if (this.loadedKey !== modelId) {
                // First load downloads weights (~4-23MB); surface it so a slow
                // download never reads as a silent freeze.
                this.onModelLoad?.(modelId);
                try {
                    await this.backend.load(modelId);
                } catch (loadErr) {
                    // One automatic retry: an aborted first attempt (stall
                    // watchdog or worker hiccup) is frequently a transient
                    // blip; a second failure disables the backend for good.
                    if (this.loadAttempts >= 1) throw loadErr;
                    this.loadAttempts++;
                    Logger.warn('[Lumos] Reranker model load failed once, retrying…', loadErr);
                    await this.backend.load(modelId);
                }
                this.loadedKey = modelId;
                this.loadAttempts = 0;
            }
            const logits = await this.backend.score(query, documents);
            return logits.map(sigmoid);
        } catch (e) {
            Logger.warn('[Lumos] Reranker failed, disabling for this session:', e);
            this.failed = true;
            this.onUnavailable?.();
            return null;
        }
    }
}

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

type Pending = {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
};

/**
 * Obsidian windows run at origin app://obsidian.md while plugin resources
 * live on a per-vault app://<hash> origin; constructing a Worker from the
 * resource URL throws SecurityError (cross-origin). Bundling the script text
 * into a same-origin blob URL is allowed everywhere.
 */
export function createBlobWorkerBackend(scriptText: string, cacheDir?: string): RerankBackend | null {
    try {
        const blob = new Blob([scriptText], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        return new WorkerBackend(url, cacheDir);
    } catch (e) {
        Logger.warn('[Lumos] Could not spawn reranker worker from blob URL:', e);
        return null;
    }
}

class WorkerBackend implements RerankBackend {
    private worker: Worker;
    private pending: Map<number, Pending> = new Map();
    private nextId = 1;
    private readyResolve: (() => void) | null = null;
    private readyReject: ((reason: any) => void) | null = null;
    private onLoadProgress: ((progress: RerankerProgress) => void) | null = null;
    private sawAnyProgress = false;
    private lastActivity = 0;

    constructor(url: string, private cacheDir?: string) {
        this.worker = new Worker(url);
        this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
        this.worker.onerror = () => this.failAll(new Error('reranker worker crashed'));
    }

    setOnLoadProgress(cb?: (progress: RerankerProgress) => void) {
        this.onLoadProgress = cb ?? null;
    }

    async load(modelId: string): Promise<void> {
        // First load downloads model weights (~4-23MB). A flat wall-clock cap
        // aborts real downloads on slow links, so instead watch for *stalls*:
        // tolerate any activity, only give up when there is none for a while.
        const FIRST_PROGRESS_MS = 30000;
        const IDLE_MS = 90000;
        const MAX_LOAD_MS = 15 * 60 * 1000;

        this.sawAnyProgress = false;
        this.lastActivity = Date.now();

        const ready = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });

        const abort = (message: string) => {
            this.readyReject?.(new Error(message));
            this.readyResolve = null;
            this.readyReject = null;
        };

        const firstTimer = setTimeout(() => {
            if (!this.sawAnyProgress) abort('model download stalled before any progress');
        }, FIRST_PROGRESS_MS);
        const idleTimer = setInterval(() => {
            if (!this.sawAnyProgress) return;
            if (Date.now() - this.lastActivity > IDLE_MS) abort('model download stalled (no progress)');
        }, 5000);
        const maxTimer = setTimeout(() => abort('model load exceeded time budget'), MAX_LOAD_MS);

        try {
            this.post({ type: 'load', modelId, cacheDir: this.cacheDir });
            await ready;
        } finally {
            clearTimeout(firstTimer);
            clearInterval(idleTimer);
            clearTimeout(maxTimer);
        }
    }

    async score(query: string, documents: string[]): Promise<number[]> {
        return this.request('rerank', { query, documents }, 60000);
    }

    terminate() {
        this.worker.terminate();
    }

    private post(payload: any) {
        const id = this.nextId++;
        this.worker.postMessage({ id, ...payload });
        return id;
    }

    private request(type: string, payload: any, timeoutMs: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`reranker request ${type} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, type, ...payload });
        });
    }

    private onMessage(msg: any) {
        if (msg?.type === 'ready') {
            this.readyResolve?.();
            this.readyResolve = null;
            this.readyReject = null;
            return;
        }
        if (msg?.type === 'load_progress') {
            this.sawAnyProgress = true;
            this.lastActivity = Date.now();
            this.onLoadProgress?.({
                status: msg.status,
                file: msg.file,
                percent: typeof msg.progress === 'number' ? msg.progress : null,
                loaded: msg.loaded,
                total: msg.total,
            });
            return;
        }
        if (msg?.type === 'error' && !msg.id) {
            this.readyReject?.(new Error(msg.message));
            this.readyReject = null;
            return;
        }
        const entry = this.pending.get(msg?.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.type === 'scores') entry.resolve(msg.scores);
        else entry.reject(new Error(msg.message ?? 'worker error'));
    }

    private failAll(err: Error) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this.pending.clear();
        this.readyReject?.(err);
    }
}

/**
 * In-process backend used only by the eval harness (LUMOS_EVAL=1), never by
 * the plugin runtime — inference must stay off the UI thread there.
 */
async function createInlineBackend(): Promise<RerankBackend> {
    return createEvalBackend();
}

export async function createEvalBackend(): Promise<RerankBackend> {
    const tf: any = await import('@huggingface/transformers');
    let tokenizer: any = null;
    let model: any = null;
    let loadedId = '';

    return {
        async load(modelId: string) {
            if (loadedId === modelId) return;
            tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
            model = await tf.AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8' });
            loadedId = modelId;
        },
        async score(query: string, documents: string[]) {
            const scores: number[] = [];
            const BATCH = 16;
            for (let i = 0; i < documents.length; i += BATCH) {
                const docs = documents.slice(i, i + BATCH);
                const inputs = tokenizer(new Array(docs.length).fill(query), {
                    text_pair: docs,
                    padding: true,
                    truncation: true,
                    max_length: 512,
                });
                const out = await model(inputs);
                const dims: number[] = out.logits.dims;
                const numLabels = dims[1] ?? 1;
                const data: any = out.logits.data;
                for (let j = 0; j < docs.length; j++) {
                    scores.push(numLabels === 1 ? data[j] : data[j * numLabels + 1]);
                }
            }
            return scores;
        },
    };
}
