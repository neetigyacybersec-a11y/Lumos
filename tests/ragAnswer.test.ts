import { describe, it, expect, vi } from 'vitest';
import { RagAnswerer, formatContext, buildMessages, RagAnswerHost } from '../src/ragAnswer';

describe('formatContext', () => {
    it('renders each source block with a uniform [Source: path] label', () => {
        const text = formatContext([
            { filePath: 'a.md', text: 'alpha', similarity: 0.9 },
            { filePath: 'b.md', text: 'beta', similarity: 0.7 },
        ]);
        expect(text).toBe('[Source: a.md]\nalpha\n\n[Source: b.md]\nbeta');
    });

    it('renders an empty string for no sources', () => {
        expect(formatContext([])).toBe('');
    });
});

describe('buildMessages', () => {
    it('places the system prompt first, then history, then the current query', () => {
        const messages = buildMessages(
            'sys',
            [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }],
            'u2'
        );
        expect(messages).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
        ]);
    });
});

describe('RagAnswerer', () => {
    function makeHost(): { host: RagAnswerHost; chatStream: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> } {
        const chatStream = vi.fn(async (_messages: any[], onChunk?: (c: string) => void) => {
            onChunk?.('part1');
            onChunk?.('part2');
            return 'part1part2';
        });
        const retrieve = vi.fn(async () => [{ filePath: 'safety.md', text: 'safe', similarity: 0.8 }]);
        return { host: { llmService: { chatStream }, hybridRetriever: { retrieve } } as any, chatStream, retrieve };
    }

    it('records a single retrieval policy for contextFor', async () => {
        const { host, retrieve } = makeHost();
        const rag = new RagAnswerer(host);

        const context = await rag.contextFor('thorium', 3);

        expect(retrieve).toHaveBeenCalledWith({ query: 'thorium', topK: 3 });
        expect(context).toBe('[Source: safety.md]\nsafe');
    });

    it('streams a completion built as system + history + query', async () => {
        const { host, chatStream } = makeHost();
        const rag = new RagAnswerer(host);

        const chunks: string[] = [];
        const answer = await rag.streamAnswer(
            'sys',
            [{ role: 'user', content: 'u1' }],
            'u2',
            (c) => chunks.push(c)
        );

        expect(chunks).toEqual(['part1', 'part2']);
        expect(answer).toBe('part1part2');
        expect(chatStream).toHaveBeenCalledWith(
            [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }],
            expect.any(Function)
        );
    });

    it('can stream without a chunk callback', async () => {
        const { host, chatStream } = makeHost();
        const rag = new RagAnswerer(host);
        const answer = await rag.streamAnswer('sys', [], 'q');
        expect(answer).toBe('part1part2');
        expect(chatStream).toHaveBeenCalledWith(
            [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
            undefined
        );
    });
});