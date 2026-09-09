import { describe, it, expect, vi } from 'vitest';
import { ChatLogic } from '../src/chatLogic';
import { ChatPort } from '../src/ports';

function makePort(overrides: Partial<ChatPort> = {}): ChatPort & { llmCalls: any[][]; contextCalls: any[] } {
    const llmCalls: any[][] = [];
    const contextCalls: any[] = [];
    const llmService: any = {
        callLLM: vi.fn(async (messages: any[]) => {
            llmCalls.push(messages);
            const isDecider = messages[0]?.content?.startsWith('You are an internal routing AI');
            return isDecider ? 'nuclear reactor safety' : 'the response';
        }),
    };
    const ragAnswer: any = {
        contextFor: vi.fn(async (query: string, topK?: number) => {
            contextCalls.push({ query, topK });
            return '[Source: safety.md]\nLiquid fluoride thorium reactors are intrinsically safe.';
        }),
    };
    return {
        app: { vault: { read: vi.fn(async () => 'focused note content'), getAbstractFileByPath: vi.fn(() => null) } },
        settings: { userProfilePath: 'profile.md' },
        llmService,
        ragAnswer,
        activityLog: [],
        ...overrides,
        // keep the spies reachable regardless of overrides
        llmCalls,
        contextCalls,
    };
}

describe('ChatLogic', () => {
    it('routes a query through RAG when the decider asks, and records the exchange into history', async () => {
        const port = makePort();
        const chat = new ChatLogic(port);
        port.llmService.callLLM = vi.fn(async (messages: any[]) => {
            port.llmCalls.push(messages);
            const isDecider = messages[0]?.content?.startsWith('You are an internal routing AI');
            return isDecider ? 'thorium safety' : 'The answer about thorium.';
        });

        const answer = await chat.generateResponse('is thorium safe?');

        expect(answer).toBe('The answer about thorium.');
        // Decider call + final generation call
        expect(port.llmCalls).toHaveLength(2);
        // Decider chose to search
        expect(port.contextCalls).toHaveLength(1);
        expect(port.contextCalls[0]).toEqual({ query: 'thorium safety', topK: 3 });
        // The final messages embed the retrieved context
        const final = port.llmCalls[1];
        expect(final.some((m: any) => m.content.includes('safety.md'))).toBe(true);

        // A follow-up question carries the prior turn in history
        await chat.generateResponse('and about heat?');
        expect(port.llmCalls[2][1]).toEqual({ role: 'user', content: 'is thorium safe?' });
        expect(port.llmCalls[2][2]).toEqual({ role: 'assistant', content: 'The answer about thorium.' });
    });

    it('skips search when the decider says NO_SEARCH', async () => {
        const port = makePort();
        const chat = new ChatLogic(port);
        port.llmService.callLLM = vi.fn(async (messages: any[]) => {
            port.llmCalls.push(messages);
            const isDecider = messages[0]?.content?.startsWith('You are an internal routing AI');
            return isDecider ? 'NO_SEARCH' : 'no search needed';
        });

        await chat.generateResponse('hello');

        expect(port.contextCalls).toHaveLength(0);
        expect(port.llmCalls).toHaveLength(2);
    });

    it('uses the focus file as context instead of searching', async () => {
        const port = makePort();
        const chat = new ChatLogic(port);

        await chat.generateResponse('summarize this', { path: 'note.md' } as any);

        expect(port.app.vault.read).toHaveBeenCalledWith({ path: 'note.md' });
        expect(port.contextCalls).toHaveLength(0);
        // Only the final generation call happens (no decider), and it carries the focused content
        expect(port.llmCalls).toHaveLength(1);
        const final = port.llmCalls[0];
        expect(final.some((m: any) => m.content.includes('focused note content'))).toBe(true);
    });
});