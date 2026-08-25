# Lumos

An intelligent, privacy-first Obsidian plugin that illuminates the connections hidden inside your vault: **typed semantic relations between notes**, **hybrid BM25 + vector search**, **RAG chat grounded entirely in your own knowledge**, an evolving **AI user profile**, and vision-powered ingestion of images and PDFs — with a fully local mode where your data never leaves your machine.

## Highlights

| | |
|---|---|
| **Semantic Relation Extraction** | An LLM reads each note alongside its nearest neighbours and extracts *typed* relationships — `prerequisite`, `contradicts`, `duplicate-effort`, `extends`, `follows-up` — not just "these are similar". |
| **Hybrid Search (BM25 + Vectors)** | Keyword (BM25) and dense vector retrieval run in parallel and are fused with Reciprocal Rank Fusion, so exact terms, identifiers like `CVE-2024-3094`, *and* paraphrased concepts all surface. |
| **Local Cross-Encoder Reranking** *(opt-in)* | A quantized MiniLM/TinyBERT reranks the top fused candidates in a background worker for a final precision boost. Downloads once (~4–23MB), then runs fully offline. |
| **Smart RAG Chat** | Ask questions in plain language. Lumos retrieves the most relevant chunks from your vault and answers strictly from them, citing sources you can click. |
| **One-Click AI Commands** | Beautify (AI copyediting that weaves in real `[[backlinks]]`), Auto-Tag & Summarize, Auto-Link Entities, Extract Action Items. |
| **Vision & Local OCR** | Image notes (`.png`, `.jpg`, `.webp`) get OCR'd locally (Tesseract) and described by a vision model so they participate in search and relations. |
| **Google Calendar Sync** | Events are ingested as virtual notes and related to your project notes automatically. |
| **AI User Profile** | A self-updating markdown profile learns your projects, mood, and context from what you write, and feeds it into every answer. |
| **Privacy First** | Ignored Folders are excluded from indexing and never sent anywhere. Choose **Ollama** for a 100% local pipeline. |

## How It Works

```
                 +-------------------  Indexing Pipeline  -------------------+
 vault events -->| Watcher -> Parser -> OCR/Vision -> Chunker -> Embedder    |
 (create/modify) |             |                        |                    |
 gcal events  -->|       RelationExtractor  <---  VectorStore (IndexedDB)    |
                 |            (LLM)        hybrid candidate selection        |
                 +---------------------------+-------------------------------+
                                             v
                       typed edges -> ScoringEngine -> RelationStore
                                             v
                     sidebar  ·  automatic frontmatter backlinks  ·  graph
```

**Retrieval** is a two-stage cascade:

1. **Fusion** — BM25 (`k1=1.2`, `b=0.75`) over chunk texts and dense cosine similarity each return up to 50 candidates; **Reciprocal Rank Fusion (`k=60`)** merges them by rank position, so incomparable score scales never need normalizing and nothing needs tuning.
2. **Rerank** *(optional)* — the fused top-N go through a local ONNX cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2` or TinyBERT) running inside `reranker.worker.js`, off Obsidian's UI thread. If anything fails, Lumos silently falls back to pure fusion ranking.

**Indexing is incremental and cheap:** unchanged files are skipped by content hash; when a file changes, only chunks whose text actually changed get re-embedded, and only those changed excerpts go to the LLM for relation extraction. Empty or temporarily-failed files persist a marker row so they are never reprocessed on every startup.

## Installation

> The plugin folder name must match the plugin id: `obsidian-relation-plugin`.

### From a release / manual install

Copy these files into `<your-vault>/.obsidian/plugins/obsidian-relation-plugin/`:

| File | Required | Purpose |
|---|---|---|
| `main.js` | Yes | Plugin bundle |
| `manifest.json` | Yes | Plugin metadata |
| `styles.css` | Yes | UI styling |
| `reranker.worker.js` | For reranking | Local cross-encoder runtime (loaded only when enabled) |

Reload Obsidian, then enable **Lumos** under Settings → Community plugins.

### From source

```bash
git clone https://github.com/neetigyacybersec-a11y/Lumos.git
cd Lumos
npm install --legacy-peer-deps
npm run build    # emits main.js and reranker.worker.js
```

Then copy the four files above from the repo root.

## Configuration

Open **Settings → Lumos**.

### LLM Backend

| Provider | Notes |
|---|---|
| **Ollama (Local)** | 100% private, free. Install [Ollama](https://ollama.com), keep it running at `http://127.0.0.1:11434`, pick a chat model (`llama3`, `mistral`, ...) and an embedding model (`nomic-embed-text`). |
| **OpenRouter (Cloud)** | State-of-the-art models (`openai/gpt-4o-mini`, `anthropic/claude-3-haiku`, ...). Enter your OpenRouter API key; embeddings default to `openai/text-embedding-3-small`. |

A vision model is used to read text inside image notes (e.g. `llava` locally, `openai/gpt-4o-mini` in the cloud).

### Hybrid Search & Reranking

- **Enable Hybrid Search** *(default: on)* — BM25 + vector fusion. Free, offline, no models to download.
- **Local Reranker** *(default: off)* — `Fast (~4MB TinyBERT)` or `Accurate (~23MB MiniLM)`. English-only. The model downloads once from Hugging Face on first search, then runs offline in a worker.
- **Rerank Depth** — how many fused candidates get re-scored (5–50).

### Privacy & Exclusions

**Ignored Folders** — comma-separated paths that are never indexed and never sent to any API (local or cloud): e.g. `Journal, Passwords, Secrets`.

### Google Calendar Sync

Toggle sync, then log in with Google. Events become virtual notes (`gcal://...`) that participate in search and relations.

## Commands

Open with `Ctrl/Cmd+P`:

| Command | What it does |
|---|---|
| **Beautify Current Page** | Heavy AI copyediting of the active note: fixes grammar, formats tasks into `- [ ]` checklists and data into tables, and organically inserts `[[backlinks]]` to related notes using RAG context. |
| **Auto-Tag & Summarize Note** | Extracts tags + a summary into the note's frontmatter (`tags`, `description`). |
| **Auto-Link Entities** | Finds vault concepts mentioned in the active note (or selection) and turns them into `[[wikilinks]]`. |
| **Extract Action Items** | Appends an "## Action Items" section parsed from the active note. |
| **Clear Index and Re-scan Vault** | Wipes vectors + relations and rebuilds from scratch. |
| **Force Re-index Current File** | Nukes and reprocesses the active file only. |
| **Retry Failed/Empty Files** | Requeues files that previously failed or had no extractable text. |

Sidebar icons: **LLM Relations** (relations sidebar), **Semantic Search**, **AI Chat**.

## How Relations Are Scored

Every candidate edge gets an overall score combining:

- **LLM confidence** in the typed relation
- **Cosine similarity** between the two notes' best chunks
- **Keyword overlap**, **folder proximity**, and **recency**

Only edges above your **Display Threshold** are shown by default; the rest hide behind a toggle. With **Auto-Add Backlinks** enabled, high-confidence relations (>= Backlink Confidence Threshold) are injected into the target notes' YAML frontmatter under `ai_relations`, which also populates Obsidian's Graph View.

## Troubleshooting

- **Something indexed wrong / model changed?** Run *Clear Index and Re-scan Vault*.
- **A file keeps failing** (bad PDF, vision hiccup)? It is marked failed once, then retried on demand via *Retry Failed/Empty Files* — never in a costly loop at startup.
- **Reranker not applying?** Check that `reranker.worker.js` is present next to `main.js`; the first search after enabling downloads the model (~4–23MB) from Hugging Face. Any failure falls back to fusion ranking automatically.
- **Debugging**: enable logs via *Settings → Open Debug Log* (`lumos-debug.log` inside the plugin folder).

## Development

```bash
npm install --legacy-peer-deps
npm run dev      # watch mode (main.js + reranker.worker.js)
npm run build    # production build
npm run test     # vitest suite
```

- The reranker ships as a **separate esbuild bundle** (`reranker.worker.js`) so the ML runtime stays out of the main plugin bundle and off the UI thread.
- Retrieval quality harness (needs a running Ollama with `nomic-embed-text`):

  ```bash
  LUMOS_EVAL=1 npx vitest run tests/retrieval-eval.test.ts
  ```

  It reports Recall@10 / MRR@10 / nDCG@10 for dense-only vs hybrid vs hybrid+reranker over a golden query set.

### Architecture Map

```
src/
├── main.ts               plugin entry; wiring & commands
├── indexer.ts            background queue, incremental chunk indexing, retries
├── watcher.ts            vault event debounce
├── parser.ts             markdown/PDF extraction
├── embeddings.ts         chunking + embedding calls (Ollama/OpenRouter)
├── vectorStore.ts        IndexedDB persistence, cosine search, mutation hooks
├── search/
│   ├── lexicalIndex.ts   dependency-free BM25 inverted index
│   ├── hybridRetriever.ts RRF fusion + rerank cascade
│   ├── reranker.ts       worker lifecycle, graceful degradation
│   └── reranker.worker.ts ONNX cross-encoder (separate bundle)
├── relations.ts          LLM relation extraction prompts/parsing
├── scoring.ts            keyword/folder/recency scoring engine
├── relationStore.ts      typed edge persistence (relations.json)
├── backlinker.ts         frontmatter ai_relations injection
├── sidebarView.ts        relations sidebar UI
├── searchView.ts         semantic search + RAG view
├── chatView.ts / chatLogic.ts   chat UI + orchestration
├── llmService.ts         LLM calls, circuit breaking, error taxonomy
├── userProfile.ts        evolving AI profile manager
├── googleAuth.ts / googleCalendar.ts
├── localOcr.ts / vision.ts   image text extraction
└── settings.ts / types.ts / logger.ts / utils.ts
```

## License

MIT
