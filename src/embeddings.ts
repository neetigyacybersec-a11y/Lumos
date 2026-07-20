import { PluginSettings } from './types';
import { requestUrl } from 'obsidian';

export class EmbeddingPipeline {
    settings: PluginSettings;

    constructor(settings: PluginSettings) {
        this.settings = settings;
    }

    chunkText(text: string, maxTokensApprox: number = 500): string[] {
        if (!text || text.trim() === '') return [];
        const paragraphs = text.split(/\n\s*\n/);
        const chunks: string[] = [];
        let currentChunk = '';
        
        for (const p of paragraphs) {
            // Rough estimation: 4 chars per token
            if ((currentChunk.length + p.length) / 4 > maxTokensApprox && currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            currentChunk += p + '\n\n';
        }
        
        if (currentChunk.trim().length > 0) {
            chunks.push(currentChunk.trim());
        }
        return chunks;
    }

    async embed(text: string): Promise<number[]> {
        if (this.settings.provider === 'ollama') {
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/api/embeddings';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.settings.embeddingModelName || (this.settings.provider === 'ollama' ? 'nomic-embed-text' : 'openai/text-embedding-3-small'),
                    prompt: text
                })
            });
            if (res.status !== 200) throw new Error('Ollama embedding failed');
            return res.json.embedding;
        } else {
            // OpenRouter OpenAI-compatible
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/embeddings';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: this.settings.embeddingModelName || 'openai/text-embedding-3-small',
                    input: text
                })
            });
            if (res.status !== 200) throw new Error('OpenRouter embedding failed');
            return res.json.data[0].embedding;
        }
    }
}
