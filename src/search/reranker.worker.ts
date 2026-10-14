/**
 * Reranker worker: bundles @huggingface/transformers and runs the ONNX
 * cross-encoder off Obsidian's UI thread. Built as a separate IIFE bundle
 * (reranker.worker.js) by esbuild.config.mjs.
 *
 * Protocol:
 *   main -> worker: {id, type:'load',  modelId, files?}
 *                   {id, type:'rerank', query, documents}
 *   worker -> main: {type:'ready'}
 *                   {id, type:'scores', scores}
 *                   {id?, type:'error', message}
 *
 * In the plugin, `files` holds the model bytes persisted to disk by the main
 * thread. The worker loads strictly from them (custom in-memory cache, no
 * network, no browser CacheStorage — both of which stall under Obsidian's
 * app:// origin). The `cacheDir` FSCache path remains only as a fallback for
 * environments without `files` (eval harness).
 */

let tokenizer: any = null;
let model: any = null;
let loadedId = '';

function applyCacheDir(tf: any, cacheDir?: string) {
    if (!cacheDir) return;
    try {
        tf.env.cacheDir = cacheDir;
        tf.env.useFSCache = true;
    } catch (e) {
        // Electron worker FS may be unavailable; a cache miss only re-downloads.
    }
}

/**
 * Point ONNX Runtime Web at locally supplied wasm factory + binary instead of
 * its jsDelivr default. A worker at Obsidian's app:// origin stalls on that
 * fetch (the same failure mode the model cache fixed), so the runtime bytes
 * travel with the model.
 *
 * ORT reads its config from its OWN module-level `env` (`ONNX_ENV` in
 * transformers.web.js). transformers keeps a SHALLOW COPY at
 * `tf.env.backends.onnx`, and in Obsidian's worker that copy has no `wasm`
 * child, so mutations there are ignored. We therefore set the overrides on
 * `ort.env.wasm` directly (esbuild dedupes the import, so it is the SAME
 * module instance transformers bundled) and mirror them onto the copy so any
 * transformers-side env reads see them too.
 *
 * The wasm *binary* is provided as `wasmBinary` (ORT checks that before any
 * file fetch); only the ~24KB JS factory is wrapped in a blob URL. Threading
 * is forced to 1 (the simd-threaded build's pthread copies fetch their own
 * wasm file, which stalls at app://; plain non-asyncify wasm compiles in ~20ms).
 */
function applyLocalRuntime(tf: any, ort: any, runtime: { mjs?: Uint8Array; wasm?: Uint8Array }) {
    if (!ort?.env?.wasm) return;
    const toBlob = (bytes?: Uint8Array, type = 'application/octet-stream') => {
        if (!bytes || bytes.byteLength === 0) return undefined;
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return URL.createObjectURL(new Blob([copy], { type }));
    };
    const wasmEnv = ort.env.wasm;
    let wasmPathsMjs: string | undefined;
    const mjsBytes = runtime?.mjs;
    if (mjsBytes && mjsBytes.byteLength > 0) {
        // Obsidian's app:// worker is cross-origin-isolated (SharedArrayBuffer
        // present), so ORT's simd-threaded glue tries to spin up a pthread
        // pool whose worker fetches its own copy of the wasm — and that fetch
        // blocks the worker thread forever at app://. Neutralize the threading
        // gate by feeding the glue a world where `globalThis.SharedArrayBuffer`
        // is null (the exact condition under which the plain build already runs
        // single-threaded in Electron). The two references act as:
        //   var SharedArrayBuffer=globalThis.SharedArrayBuffer??fallback;
        //   ... if(!globalThis.SharedArrayBuffer)return 6; // spawn gate
        const factory = new TextDecoder().decode(mjsBytes);
        const patched = factory.split('globalThis.SharedArrayBuffer').join('null');
        wasmPathsMjs = toBlob(new TextEncoder().encode(patched), 'text/javascript');
        if (wasmPathsMjs) {
            wasmEnv.wasmPaths = { mjs: wasmPathsMjs, wasm: undefined };
        }
    }
    const wasmBytes = runtime?.wasm;
    if (wasmBytes && wasmBytes.byteLength > 0) {
        wasmEnv.wasmBinary = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes as ArrayBuffer);
    }
    if (wasmEnv.numThreads !== 1) {
        wasmEnv.numThreads = 1;
    }
    // Mirror onto transformers' shallow copy (may lack `wasm` in some workers).
    const copyWasm = tf?.env?.backends?.onnx?.wasm;
    if (copyWasm && copyWasm !== wasmEnv) {
        if (wasmPathsMjs) copyWasm.wasmPaths = { mjs: wasmPathsMjs, wasm: undefined };
        if (wasmBytes && wasmBytes.byteLength > 0) {
            copyWasm.wasmBinary = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes as ArrayBuffer);
        }
    }
}

function applyLocalFiles(tf: any, modelId: string, files: Record<string, Uint8Array>) {
    // Serve every requested file from an in-memory cache keyed exactly the way
    // transformers.js will look it up (both the local path and the remote URL),
    // and forbid network + disk fallbacks so loading is fully offline.
    const map = new Map<string, ArrayBuffer>();
    const root = '/lumos-models';
    for (const [rel, bytes] of Object.entries(files)) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        const buf = copy.buffer;
        for (const key of [
            `${root}/${modelId}/${rel}`,
            `https://huggingface.co/${modelId}/resolve/main/${rel}`,
        ]) {
            map.set(key, buf);
        }
    }
    tf.env.localModelPath = root;
    tf.env.useCustomCache = true;
    tf.env.customCache = {
        async match(key: string) {
            const b = map.get(key);
            if (!b) return undefined;
            return new Response(b, {
                status: 200,
                headers: {
                    'content-length': String(b.byteLength),
                    'content-type': 'application/octet-stream',
                },
            });
        },
        async put() {},
    };
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
}

async function ensureModel(
    modelId: string,
    cacheDir?: string,
    files?: Record<string, Uint8Array>,
    runtime?: { mjs?: Uint8Array; wasm?: Uint8Array }
) {
    if (loadedId === modelId) return;
    // Transformers picks its ONNX module in this priority order:
    //   1. globalThis[Symbol.for('onnxruntime')] if the property exists,
    //   2. onnxruntime-node (native; its exports are `undefined` here) when
    //      `process.release.name === 'node'` (true in Obsidian's worker!),
    //   3. the bundled webgpu build (fully wired, includes the wasm backend).
    // The node branch makes `ONNX.InferenceSession` undefined and session
    // creation throws "Cannot read properties of undefined (reading 'create')".
    // Hide `process` + the ort symbol so branch (3) is taken, then import the
    // exact module transformers references (same bundled instance) so our wasm
    // overrides below land on the env transformers actually reads.
    const g = globalThis as any;
    try {
        delete g.process;
    } catch {
        /* not configurable in some environments */
    }
    try {
        delete g[Symbol.for('onnxruntime')];
    } catch {
        /* ignore */
    }
    const ort: any = await import('onnxruntime-web/webgpu');
    const tf: any = await import('@huggingface/transformers');
    stage('imported');
    // Surface transformers.js download/load progress to the main thread so the
    // UI can show the user what is happening instead of looking like a freeze.
    const progress = (info: any) => {
        ctx.postMessage({
            id: undefined,
            type: 'load_progress',
            name: info?.name ?? modelId,
            file: info?.file ?? '',
            status: info?.status ?? '',
            progress: info?.progress ?? null,
            loaded: info?.loaded ?? null,
            total: info?.total ?? null,
        });
    };
    if (files) {
        stage('files');
        applyLocalFiles(tf, modelId, files);
    } else {
        applyCacheDir(tf, cacheDir);
    }
    if (runtime) {
        stage('runtime');
        stage('sab:' + (typeof SharedArrayBuffer !== 'undefined' ? 'y' : 'n') + (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? ':coi' : ''));
        applyLocalRuntime(tf, ort, runtime);
        stage(
            'wcfg ' +
                JSON.stringify({
                    ortPaths: ort?.env?.wasm?.wasmPaths ? Object.keys(ort.env.wasm.wasmPaths) : null,
                    ortBin: ort?.env?.wasm?.wasmBinary ? ort.env.wasm.wasmBinary.byteLength : 0,
                })
        );
        if (runtime.wasm && runtime.wasm.byteLength > 0) {
            stage('wasmcompile');
            const wasmT0 = Date.now();
            try {
                await WebAssembly.instantiate(
                    runtime.wasm instanceof Uint8Array ? runtime.wasm : new Uint8Array(runtime.wasm as ArrayBuffer),
                    {}
                );
                stage('wasmcompile:ok ' + (Date.now() - wasmT0) + 'ms');
            } catch (e: any) {
                stage('wasmcompile:err ' + (Date.now() - wasmT0) + 'ms ' + String(e?.message ?? e).slice(0, 80));
            }
        }
    }
    const opts = { progress_callback: progress, local_files_only: !!files };
    stage('pretrained');
    const claw = (name: string, obj: any, fn: string) => {
        const orig = obj?.[fn];
        if (typeof orig !== 'function') {
            stage(name + ':no-api');
            return;
        }
        obj[fn] = async (...args: any[]) => {
            stage(name + ':begin');
            try {
                const out = await orig.apply(obj, args);
                stage(name + ':ok');
                return out;
            } catch (e: any) {
                stage(name + ':err ' + String(e?.message ?? e).slice(0, 100));
                throw e;
            }
        };
    };
    claw('from_pretrained', tf.AutoModelForSequenceClassification, 'from_pretrained');
    claw('session_create', tf.ort?.InferenceSession, 'create');
    tokenizer = await tf.AutoTokenizer.from_pretrained(modelId, opts);
    stage('tokenizer_ready');
    model = await tf.AutoModelForSequenceClassification.from_pretrained(modelId, {
        ...opts,
        dtype: 'q8',
    });
    loadedId = modelId;
}

async function scoreBatch(query: string, docs: string[]): Promise<number[]> {
    stage('tokenize');
    const inputs = tokenizer(new Array(docs.length).fill(query), {
        text_pair: docs,
        padding: true,
        truncation: true,
        max_length: 512,
    });
    stage('inference');
    const out = await model(inputs);
    stage('extract');
    const dims: number[] = out.logits.dims;
    const numLabels = dims[1] ?? 1;
    const data: any = out.logits.data;
    const scores: number[] = [];
    for (let j = 0; j < docs.length; j++) {
        // Single-logit regression heads (MS MARCO) vs two-class heads.
        scores.push(numLabels === 1 ? data[j] : data[j * numLabels + 1]);
    }
    return scores;
}

const ctx: any = self;

function stage(s: string) {
    ctx.postMessage({ type: 'debug', stage: s });
}

ctx.onmessage = async (ev: MessageEvent) => {
    const msg = ev.data;
    try {
        if (msg.type === 'load') {
            stage('ensureModel');
            await ensureModel(msg.modelId, msg.cacheDir, msg.files, msg.runtime);
            stage('ready');
            ctx.postMessage({ type: 'ready' });
            return;
        }
if (msg.type !== 'rerank') return;
        if (!loadedId) {
            ctx.postMessage({ id: msg.id, type: 'error', message: 'model not loaded' });
            return;
        }
        stage('score');
        const scores: number[] = [];
        const BATCH = 16;
        for (let i = 0; i < msg.documents.length; i += BATCH) {
            scores.push(...(await scoreBatch(msg.query, msg.documents.slice(i, i + BATCH))));
        }
        stage('scores-sent');
        ctx.postMessage({ id: msg.id, type: 'scores', scores });
    } catch (e: any) {
        ctx.postMessage({ id: msg.id, type: 'error', message: String(e?.message ?? e) + ' || ' + String(e?.stack ?? '').slice(0, 900) });
    }
};
