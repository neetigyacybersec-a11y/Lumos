import { Logger } from '../logger';

/**
 * Minimal slice of Obsidian's VaultAdapter needed to persist the ONNX
 * cross-encoder weights and runtime under the plugin folder.
 */
export interface ModelFileStorage {
    exists(path: string): Promise<boolean> | boolean;
    readBinary?(path: string): Promise<ArrayBuffer> | ArrayBuffer;
    writeBinary?(path: string, data: ArrayBuffer): Promise<void> | void;
    /** Create a directory (recursively like `mkdir -p`); resolve once present. */
    mkdir?(path: string): Promise<void> | void;
}

export interface ModelFileOperator {
    ensureLocalModel(modelId: string): Promise<void>;
    readModelFiles(modelId: string): Promise<Record<string, ArrayBuffer>>;
    /** ONNX Runtime Web's wasm JS factory + binary, mirrored for offline use. */
    ensureRuntime(): Promise<void>;
    readRuntimeFiles(): Promise<Record<'mjs' | 'wasm', ArrayBuffer>>;
}

/** Files `AutoModelForSequenceClassification.from_pretrained` actually needs. */
const MODEL_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
];

/**
 * onnxruntime-web ships only its JS glue in the npm package; at inference time
 * it fetches these binaries from a CDN. A worker at Obsidian's app:// origin
 * stalls on that fetch, exactly like the model fetch it replaced — so these
 * runtime files are mirrored on the same `models` branch as the weights and
 * pulled onto disk, handing them to the worker directly.
 *
 * The reranker runs inside a dedicated Worker, so the plain (non-asyncify)
 * threaded build is the correct one: the asyncify variant (built for main-thread
 * `proxy` inference) is 23.5MB and never finished compiling in Obsidian's
 * renderer, while the plain pair compiles in <1s.
 *
 * Records the onnxruntime-web version the mirror was populated from; keep in
 * lockstep with the onnxruntime-web bundled by @huggingface/transformers.
 */
const ORT_WEB_VERSION = '1.26.0-dev.20260416-b7804b056c';
const RUNTIME_FILES: { rel: string; key: 'mjs' | 'wasm' }[] = [
    { rel: 'ort-wasm-simd-threaded.mjs', key: 'mjs' },
    { rel: 'ort-wasm-simd-threaded.wasm', key: 'wasm' },
];

/**
 * The reranker weights and the ONNX runtime are mirrored on a dedicated
 * `models` branch of the plugin's own repo, so nothing is fetched from
 * HuggingFace or jsDelivr at runtime.
 *
 * Served from raw.githubusercontent.com rather than a GitHub Release because
 * release-asset endpoints send no `Access-Control-Allow-Origin` header, and a
 * fetch() from Obsidian's `app://` origin is rejected by CORS.
 */
const MIRROR_BASE = 'https://raw.githubusercontent.com/neetigyacybersec-a11y/Lumos/models';

/** HuggingFace repo id -> its directory on the mirror branch. */
const MIRROR_MODEL_DIRS: Record<string, string> = {
    'Xenova/ms-marco-TinyBERT-L-2-v2': 'reranker/tiny',
    'Xenova/ms-marco-MiniLM-L-6-v2': 'reranker/mini',
};

/**
 * Resolves one model file on the mirror. An unmapped model id is used as the
 * path verbatim, so publishing a new model means adding a matching directory on
 * the branch rather than editing this file.
 */
export function modelUrlFor(modelId: string, file: string): string {
    return `${MIRROR_BASE}/${MIRROR_MODEL_DIRS[modelId] ?? modelId}/${file}`;
}

export function runtimeUrlFor(rel: string): string {
    return `${MIRROR_BASE}/runtime/${rel}`;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Downloads the reranker ONNX files (and the ONNX runtime wasm) to real disk on
 * the main thread (via the vault adapter — outside both the app:// origin's
 * CacheStorage and the worker fetch path that stall in Obsidian), then hands
 * the bytes to the worker to load fully offline.
 *
 * Files live under `<pluginFolder>/models/<modelId>/...` and
 * `<pluginFolder>/runtime/...`, so they persist across sessions and download
 * exactly once.
 */
export function createLocalModelStore(storage: ModelFileStorage, baseDir: string): ModelFileOperator {
    const filePath = (modelId: string, file: string) => `${baseDir}/${modelId}/${file}`;
    const runtimePath = (rel: string) => `${baseDir}/runtime/${rel}`;

    /**
     * obsidian's vault adapter `exists`/`writeBinary` do NOT create parent
     * directories, so every ancestor of {@link target} has to be created up
     * front (adapter `mkdir` is non-recursive).
     */
    async function ensureDirectoryTree(target: string): Promise<void> {
        if (typeof storage.mkdir !== 'function') return;
        const ancestors = target.split('/');
        ancestors.pop();
        let acc = '';
        for (const part of ancestors) {
            acc = acc ? `${acc}/${part}` : part;
            try {
                if (await storage.exists(acc)) continue;
            } catch {
                /* fall through to mkdir */
            }
            try {
                await storage.mkdir(acc);
            } catch (e) {
                // Concurrent creation or an ancestor that vanished mid-write:
                // treat "already exists" as success, rethrow everything else.
                if ((e as { message?: string })?.message?.includes('already exists')) continue;
                throw e;
            }
        }
    }

    async function downloadFrom(url: string, label: string): Promise<ArrayBuffer | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        try {
            Logger.info(`[Lumos] Downloading ${label}`);
            const res = await fetch(url, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} for ${label}`);
            }
            const buf = await res.arrayBuffer();
            Logger.info(`[Lumos] Downloaded ${label} (${buf.byteLength} bytes)`);
            return buf;
        } catch (e) {
            Logger.warn(`[Lumos] Failed to download ${label}:`, e);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchToDisk(path: string, url: string, label: string, targetPath: string): Promise<boolean> {
        const buf = await downloadFrom(url, label);
        if (!buf) return false;
        try {
            await ensureDirectoryTree(targetPath);
            await storage.writeBinary?.(path, buf);
            return true;
        } catch (e) {
            Logger.warn(`[Lumos] writeBinary(${path}) failed:`, e);
            return false;
        }
    }

    async function exists(path: string): Promise<boolean> {
        try {
            return await storage.exists(path);
        } catch (e) {
            Logger.warn(`[Lumos] exists(${path}) failed:`, e);
            return false;
        }
    }

    async function ensureLocalModel(modelId: string): Promise<void> {
        const missing: string[] = [];
        for (const file of MODEL_FILES) {
            const path = filePath(modelId, file);
            if (await exists(path)) continue;
            const ok = await fetchToDisk(path, modelUrlFor(modelId, file), `${modelId}/${file}`, path);
            if (!ok) missing.push(file);
        }
        if (missing.length > 0) {
            throw new Error(
                `reranker model ${modelId} missing local files: ${missing.join(', ')} (check plugin folder permissions)`
            );
        }
    }

    async function ensureRuntime(): Promise<void> {
        const missing: string[] = [];
        for (const { rel } of RUNTIME_FILES) {
            const path = runtimePath(rel);
            if (await exists(path)) continue;
            const ok = await fetchToDisk(path, runtimeUrlFor(rel), `onnxruntime/${rel}`, path);
            if (!ok) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `onnx runtime missing local files: ${missing.join(', ')} `
                + `(mirror must carry onnxruntime-web@${ORT_WEB_VERSION}; check plugin folder permissions)`
            );
        }
    }

    async function readModelFiles(modelId: string): Promise<Record<string, ArrayBuffer>> {
        if (typeof storage.readBinary !== 'function') {
            throw new Error('vault adapter has no readBinary; cannot feed the reranker worker');
        }
        const out: Record<string, ArrayBuffer> = {};
        for (const file of MODEL_FILES) {
            out[file] = await storage.readBinary(filePath(modelId, file));
        }
        return out;
    }

    async function readRuntimeFiles(): Promise<Record<'mjs' | 'wasm', ArrayBuffer>> {
        if (typeof storage.readBinary !== 'function') {
            throw new Error('vault adapter has no readBinary; cannot feed the ONNX runtime to the worker');
        }
        const out: Record<'mjs' | 'wasm', ArrayBuffer> = { mjs: new ArrayBuffer(0), wasm: new ArrayBuffer(0) };
        for (const { rel, key } of RUNTIME_FILES) {
            out[key] = await storage.readBinary(runtimePath(rel));
        }
        return out;
    }

    return { ensureLocalModel, readModelFiles, ensureRuntime, readRuntimeFiles };
}
