import { ChatMessage } from './llmService';

export interface RetrieveResultItem {
    filePath: string;
    text: string;
    similarity: number;
}

/**
 * Collaborators a RagAnswerer needs: one completion seam (streaming) and one
 * retrieval seam. Structurally satisfied by LumosPlugin.
 */
export interface RagAnswerHost {
    llmService: {
        chatStream(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string>;
    };
    hybridRetriever: {
        retrieve(opts: { query: string; topK: number }): Promise<RetrieveResultItem[]>;
    };
}

/**
 * The single, predictable way retrieved notes are rendered into a system
 * prompt. searchView and chatLogic used to format context differently and had
 * already drifted apart; every RAG answer now reads the same source blocks.
 */
export function formatContext(chunks: RetrieveResultItem[]): string {
    return chunks.map(c => `[Source: ${c.filePath}]\n${c.text}`).join('\n\n');
}

/**
 * The canonical message list for every RAG completion: system prompt, prior
 * turns, then the current user query.
 */
export function buildMessages(systemPrompt: string, history: ChatMessage[], query: string): ChatMessage[] {
    return [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }];
}

/**
 * Shared "answer a question from the vault" module. Both the chat view and
 * the search view route RAG answers through here so retrieval, context
 * formatting and the completion shape are single policies instead of two
 * drifting copies.
 */
export class RagAnswerer {
    constructor(private host: RagAnswerHost) {}

    /** One retrieval policy: query -> topK notes -> formatted context. */
    async contextFor(query: string, topK: number = 5): Promise<string> {
        const similar = await this.host.hybridRetriever.retrieve({ query, topK });
        return formatContext(similar);
    }

    /** One streaming completion path for a RAG answer. */
    async streamAnswer(systemPrompt: string, history: ChatMessage[], query: string, onChunk?: (chunk: string) => void): Promise<string> {
        return this.host.llmService.chatStream(buildMessages(systemPrompt, history, query), onChunk);
    }
}