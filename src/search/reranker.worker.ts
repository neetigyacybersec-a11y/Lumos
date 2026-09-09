/**
 * Reranker worker: bundles @huggingface/transformers and runs the ONNX
 * cross-encoder off Obsidian's UI thread. Built as a separate IIFE bundle
 * (reranker.worker.js) by esbuild.config.mjs.
 *
 * Protocol:
 *   main -> worker: {id, type:'load',  modelId}
 *                   {id, type:'rerank', query, documents}
 *   worker -> main: {type:'ready'}
 *                   {id, type:'scores', scores}
 *                   {id?, type:'error', message}
 */

let tokenizer: any = null;
let model: any = null;
let loadedId = '';

async function ensureModel(modelId: string) {
    if (loadedId === modelId) return;
    const tf: any = await import('@huggingface/transformers');
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
    tokenizer = await tf.AutoTokenizer.from_pretrained(modelId, { progress_callback: progress });
    model = await tf.AutoModelForSequenceClassification.from_pretrained(modelId, {
        dtype: 'q8',
        progress_callback: progress,
    });
    loadedId = modelId;
}

function scoreBatch(query: string, docs: string[]): number[] {
    const inputs = tokenizer(new Array(docs.length).fill(query), {
        text_pair: docs,
        padding: true,
        truncation: true,
        max_length: 512,
    });
    const out = model(inputs);
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

ctx.onmessage = async (ev: MessageEvent) => {
    const msg = ev.data;
    try {
        if (msg.type === 'load') {
            await ensureModel(msg.modelId);
            ctx.postMessage({ type: 'ready' });
            return;
        }
        if (msg.type !== 'rerank') return;
        await ensureModel(msg.modelId);
        const scores: number[] = [];
        const BATCH = 16;
        for (let i = 0; i < msg.documents.length; i += BATCH) {
            scores.push(...scoreBatch(msg.query, msg.documents.slice(i, i + BATCH)));
        }
        ctx.postMessage({ id: msg.id, type: 'scores', scores });
    } catch (e: any) {
        ctx.postMessage({ id: msg.id, type: 'error', message: String(e?.message ?? e) });
    }
};
