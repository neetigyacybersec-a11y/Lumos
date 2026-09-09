/**
 * The reranker worker is a standalone IIFE bundle (reranker.worker.js) that
 * keeps @huggingface/transformers + ONNX model loading off the plugin's main
 * bundle and UI thread. Obsidian's community installer only ships main.js,
 * manifest.json and styles.css, so the worker source is inlined into main.js
 * at build time and emitted next to the plugin only when it is not already
 * present (local/dev installs and manual installs keep their own file).
 */
import { RERANKER_WORKER_SCRIPT } from '~worker-script';

export const WORKER_SCRIPT: string = RERANKER_WORKER_SCRIPT;
