# Lumos

An intelligent, privacy-first Obsidian plugin that seamlessly finds semantic relations between your notes, tracks an evolving AI User Profile, and automatically links related concepts using vector embeddings and Vision LLMs for images.

## Features

- **Semantic Relation Extraction**: Uses LLMs to find deep, non-obvious relationships between your notes, going beyond simple keyword matching.
- **Smart RAG Chat**: Chat with your vault! The AI intelligently scans your notes and uses Retrieval-Augmented Generation (RAG) to answer questions based entirely on your personal data.
- **Interactive Beautify Command**: Heavy AI-powered copyediting for your active note. Not only fixes grammar, but organically weaves in `[[backlinks]]` to your other notes using RAG context, and formats tasks into interactive checklists (`- [ ]`) and data into tables.
- **Vision & Local OCR**: Can read text within images (`.png`, `.jpg`, `.webp`) to find relations between visual content and text notes.
- **AI User Profile**: Automatically observes what you write to construct an evolving AI profile, allowing the LLM to learn your context, personality, and tone.
- **Automatic Backlinker**: Injects discovered semantic relations into the YAML frontmatter (`ai_relations`) of your notes.
- **Interactive Graph and Sidebar**: Explore your semantic web visually right from the sidebar.
- **Google Calendar Sync**: Integrates with your Google Calendar to automatically ingest and relate events to your notes!
- **LumosDB (IndexedDB)**: Features a lightning-fast, highly optimized background indexer with strict concurrency locks and Circuit Breaking, built for massive 100K+ note vaults.
- **Privacy First**: Explicit **Ignored Folders** settings to ensure your journals, diaries, and sensitive data never hit the cloud.

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder: `.obsidian/plugins/lumos/`.
2. Reload Obsidian and enable the plugin.

## Configuration

In the plugin settings, you can configure the AI backend to suit your privacy and cost needs:

### OpenRouter (Cloud)
Use state-of-the-art models like `openai/gpt-4o-mini` or `anthropic/claude-3-5-sonnet`.
1. Set LLM Backend to **OpenRouter**.
2. Enter your OpenRouter API Key.
3. Provide a Model Name.

### Ollama (Local & 100% Private)
Run models entirely on your own hardware. Your data never leaves your machine.
1. Download and install [Ollama](https://ollama.com).
2. Set LLM Backend to **Ollama**.
3. Ensure Ollama is running at `http://127.0.0.1:11434`.
4. Provide the Model Name (e.g., `llama3` or `phi3`).

### Embeddings
You will need a Nomic API Key for the vector search embeddings (`nomic-embed-text`). 

### Privacy Exclusions (Ignored Folders)
You can specify a comma-separated list of folders to exclude from indexing (e.g., `Journal, Passwords, Secrets`). Files in these folders will **never** be sent to the LLM or embedded.

## Development

```bash
npm install
npm run dev    # For watch mode
npm run build  # For production build
npm run test   # Run test suite
```

## License
MIT
