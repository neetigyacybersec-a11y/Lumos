import { requestUrl } from 'obsidian';
import LumosPlugin from './main';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class LLMService {
    plugin: LumosPlugin;

    constructor(plugin: LumosPlugin) {
        this.plugin = plugin;
    }

    async callLLM(messages: ChatMessage[], isRouting: boolean = false): Promise<string> {
        let resultText = '';
        if (this.plugin.settings.provider === 'ollama') {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/api/chat';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'llama3',
                    messages: messages,
                    stream: false
                })
            });
            if (res.status !== 200) throw new Error('Ollama generation failed');
            resultText = res.json.message.content;
        } else {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'meta-llama/llama-3-8b-instruct',
                    messages: messages
                })
            });
            if (res.status !== 200) throw new Error('OpenRouter generation failed');
            resultText = res.json.choices[0].message.content;
        }
        return resultText;
    }

    async beautifyText(text: string): Promise<string> {
        let vaultContext = '';
        try {
            const chunks = this.plugin.embeddingPipeline.chunkText(text);
            if (chunks.length > 0) {
                const embedding = await this.plugin.embeddingPipeline.embed(chunks[0]);
                const similar = this.plugin.vectorStore.querySimilar(embedding, 5);
                if (similar.length > 0) {
                    vaultContext = similar.map(c => `File: ${c.filePath}\nSnippet:\n${c.text}`).join('\n\n---\n\n');
                }
            }
        } catch (e) {
            console.error('[Lumos] Beautify RAG failed', e);
        }

        let systemPrompt = `You are an elite copyeditor and Markdown formatting expert.
Your task is to take the user's raw text and HEAVILY BEAUTIFY it.

RULES:
1. Fix all grammatical errors, typos, and awkward phrasing.
2. Format the text to make it stand out and be highly scannable. Use Markdown features aggressively: bolding, italics, bullet points, headers, and Obsidian callouts (e.g., > [!info], > [!summary], > [!important]).
3. INTERACTIVE ELEMENTS: Identify action items, open questions, or pending tasks and convert them into interactive Markdown checkboxes (- [ ]).
4. STRUCTURED DATA: Identify lists of attributes, comparisons, or structured data and format them into Markdown tables.
5. DO NOT summarize, delete, or change the underlying factual meaning or context of the text. The core information must remain 100% intact.
6. Output ONLY the formatted text. No conversational filler like "Here is your formatted text."`;

        if (vaultContext) {
            systemPrompt += `\n\n=== VAULT CONTEXT ===\n${vaultContext}\n======================\n
RULE 7: Use the VAULT CONTEXT above to weave Obsidian backlinks into the formatted text. If a concept, entity, or topic in the user's text matches a file in the context, replace the text with a backlink (e.g. [[Filename]]). Do not create random links, only link to the files provided in the context if they are highly relevant.`;
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        return await this.callLLM(messages);
    }
}
