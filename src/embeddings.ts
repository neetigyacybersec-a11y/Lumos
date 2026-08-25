import { PluginSettings } from './types';
import { createTransport } from './llm/transport';

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
        return createTransport(this.settings).embed(text);
    }
}
