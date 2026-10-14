import { describe, it, expect } from 'vitest';
import { modelUrlFor, runtimeUrlFor } from '../src/search/modelStore';

const MIRROR = 'https://raw.githubusercontent.com/neetigyacybersec-a11y/Lumos/models';

describe('modelUrlFor', () => {
	it('serves the tiny reranker from the mirror, not HuggingFace', () => {
		expect(modelUrlFor('Xenova/ms-marco-TinyBERT-L-2-v2', 'config.json'))
			.toBe(`${MIRROR}/reranker/tiny/config.json`);
	});

	it('serves the mini reranker from the mirror', () => {
		expect(modelUrlFor('Xenova/ms-marco-MiniLM-L-6-v2', 'onnx/model_quantized.onnx'))
			.toBe(`${MIRROR}/reranker/mini/onnx/model_quantized.onnx`);
	});

	it('never resolves to a third-party CDN', () => {
		for (const url of [
			modelUrlFor('Xenova/ms-marco-TinyBERT-L-2-v2', 'tokenizer.json'),
			modelUrlFor('Xenova/ms-marco-MiniLM-L-6-v2', 'tokenizer.json'),
			runtimeUrlFor('ort-wasm-simd-threaded.wasm'),
		]) {
			expect(url.startsWith(MIRROR), url).toBe(true);
			expect(url).not.toContain('huggingface.co');
			expect(url).not.toContain('jsdelivr.net');
		}
	});

	it('uses an unmapped model id verbatim, so new models need no code change', () => {
		expect(modelUrlFor('someone/Some-New-Model', 'config.json'))
			.toBe(`${MIRROR}/someone/Some-New-Model/config.json`);
	});
});

describe('runtimeUrlFor', () => {
	it('serves both pinned onnxruntime files from the mirror', () => {
		expect(runtimeUrlFor('ort-wasm-simd-threaded.mjs'))
			.toBe(`${MIRROR}/runtime/ort-wasm-simd-threaded.mjs`);
		expect(runtimeUrlFor('ort-wasm-simd-threaded.wasm'))
			.toBe(`${MIRROR}/runtime/ort-wasm-simd-threaded.wasm`);
	});
});