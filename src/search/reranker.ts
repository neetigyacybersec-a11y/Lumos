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
                await this.backend.load(modelId);
                this.loadedKey = modelId;
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
export function createBlobWorkerBackend(scriptText: string): RerankBackend | null {
    try {
        const blob = new Blob([scriptText], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        return new WorkerBackend(url);
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

    constructor(url: string) {
        this.worker = new Worker(url);
        this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
        this.worker.onerror = () => this.failAll(new Error('reranker worker crashed'));
    }

    setOnLoadProgress(cb?: (progress: RerankerProgress) => void) {
        this.onLoadProgress = cb ?? null;
    }

    async load(modelId: string): Promise<void> {
        // First load downloads model weights (~4-23MB); 60s cap so a stalled
        // download degrades to fusion ranking instead of hanging callers.
        const ready = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        const timer = setTimeout(() => this.readyReject?.(new Error('model load timed out')), 60000);
        this.post({ type: 'load', modelId });
        await ready;
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
