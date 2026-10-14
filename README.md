# Model mirror

This branch holds the binary assets Lumos's local reranker loads at runtime, so
the plugin never has to reach HuggingFace or jsDelivr. It is **asset-only** —
there is no source code here. The plugin itself lives on `main`.

Consumers fetch these files over `raw.githubusercontent.com`, which is why they
must stay on a git branch rather than a GitHub Release: release-asset endpoints
send no `Access-Control-Allow-Origin` header, so a `fetch()` from Obsidian's
`app://` origin is blocked by CORS.

## Layout

| Path | What |
|---|---|
| `reranker/tiny/` | `Xenova/ms-marco-TinyBERT-L-2-v2` — cross-encoder, ~4.3 MB ONNX |
| `reranker/mini/` | `Xenova/ms-marco-MiniLM-L-6-v2` — cross-encoder, ~22 MB ONNX |
| `runtime/` | `onnxruntime-web` SIMD+threaded wasm pair (pinned version, see below) |

Each `reranker/<key>/` directory holds exactly the four files
`AutoModelForSequenceClassification.from_pretrained` consumes:
`config.json`, `tokenizer.json`, `tokenizer_config.json`,
`onnx/model_quantized.onnx`.

The ONNX runtime pair is pinned to `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`,
matching what `@huggingface/transformers` bundles. Re-pinning means replacing
these two files and updating `ORT_WEB_VERSION` in `src/search/modelStore.ts`.

## URLs

```
https://raw.githubusercontent.com/neetigyacybersec-a11y/Lumos/models/reranker/<tiny|mini>/<file>
https://raw.githubusercontent.com/neetigyacybersec-a11y/Lumos/models/runtime/<file>
```

## Attribution

Redistribution here is permitted and governed by Apache-2.0 (reranker weights)
and MIT (ONNX runtime). See `LICENSE` and `ATTRIBUTION.md`.

- Cross-encoder weights: **Microsoft Research**, via the `cross-encoder/ms-marco-*`
  HuggingFace repos (Apache-2.0), ONNX-quantized conversions by **Xenova**
  (`Xenova/ms-marco-*-v2`).
- ONNX Runtime Web: **Microsoft Corporation** (MIT).