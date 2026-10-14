# Attribution

Binary assets mirrored on this branch, with their upstream sources and licenses.

## Reranker weights — Apache License 2.0

The cross-encoder weights are originally from Microsoft Research and were
converted to ONNX (int8, `model_quantized.onnx`) by Xenova for use with
transformers.js. Both upstream repos are Apache-2.0.

| Files | Upstream | Source repo | Upstream license |
|---|---|---|---|
| `reranker/tiny/*` | `Xenova/ms-marco-TinyBERT-L-2-v2` | derived from `cross-encoder/ms-marco-TinyBERT-L2-v2` | Apache-2.0 |
| `reranker/mini/*` | `Xenova/ms-marco-MiniLM-L-6-v2` | derived from `cross-encoder/ms-marco-MiniLM-L6-v2` | Apache-2.0 |

Copyright the respective authors. Licensed under the Apache License, Version 2.0
(the full text is in `LICENSE`); you may obtain a copy at
<https://www.apache.org/licenses/LICENSE-2.0>.

Apache-2.0 §4 redistribution conditions satisfied here: this file and the
license text travel with the assets, and the work is not modified — the files
are byte-identical copies of the upstream ones.

## ONNX Runtime Web — MIT License

| Files | Upstream | License |
|---|---|---|
| `runtime/ort-wasm-simd-threaded.mjs`, `runtime/ort-wasm-simd-threaded.wasm` | `onnxruntime-web@1.26.0-dev.20260416-b7804b056c` | MIT |

Copyright (c) Microsoft Corporation. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.