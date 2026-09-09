import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { IndexFileFlow, IndexInput, IndexFileHost } from '../src/indexing/indexFileFlow';
import { VaultFileInput, VaultFileHost } from '../src/indexing/vaultFileInput';
import { CalendarInput } from '../src/indexing/calendarInput';
import { hashString } from '../src/utils';

function makeHost(overrides: Partial<IndexFileHost> = {}): IndexFileHost {
    const host: IndexFileHost = {
        vectorStore: {
            getFileHash: vi.fn(() => undefined),
            getChunks: vi.fn(() => []),
            upsert: vi.fn(async () => {}),
            getFileCount: vi.fn(() => 5),
            dimension: undefined as number | undefined,
            recordDimension: vi.fn(),
        },
        embeddingPipeline: {
            chunkText: vi.fn((text: string) => (text ? [text] : [])),
            embed: vi.fn(async () => [1, 2]),
        },
        hybridRetriever: {
            retrieve: vi.fn(async () => [{ filePath: 'target.md', text: 'target text', similarity: 0.8 }]),
        },
        relationExtractor: {
            constructPrompt: vi.fn(() => 'prompt'),
            extractRelations: vi.fn(async () => ({ edges: [{ target: 'target.md', confidence: 0.9 }], profileInsights: null })),
        },
        relationStore: {
            getEdgesForPath: vi.fn(() => []),
            upsertEdges: vi.fn(async () => {}),
        },
    };
    return { ...host, ...overrides };
}

function makeInput(overrides: Partial<IndexInput> = {}): IndexInput & {
    extractText: ReturnType<typeof vi.fn>;
    onNoRelations: ReturnType<typeof vi.fn>;
} {
    const input = {
        path: 'a.md',
        extractText: vi.fn(async () => ({ text: 'the quick brown fox', madeNetworkCall: false })),
        promptSource: vi.fn((text: string, changed: string[], isPartial: boolean) => (isPartial ? changed.join('\n\n') : text)),
        score: vi.fn(async (edges: any[]) => edges),
        mergeOnPartial: vi.fn((_existing: any[], scored: any[]) => scored),
        afterPersist: vi.fn(async () => {}),
        onNoRelations: vi.fn(async () => {}),
    };
    return { ...input, ...overrides } as any;
}

describe('IndexFileFlow', () => {
    it('runs the full pipeline and learns the embedding dimension', async () => {
        const host = makeHost();
        const input = makeInput();
        const flow = new IndexFileFlow(host);

        const res = await flow.index(input);

        expect(host.vectorStore.upsert).toHaveBeenCalledWith('a.md', [expect.objectContaining({ text: 'the quick brown fox' })]);
        expect(host.hybridRetriever.retrieve).toHaveBeenCalledWith(expect.objectContaining({
            topK: 3, excludeFilePath: 'a.md', skipRerank: true,
        }));
        expect(host.relationExtractor.constructPrompt).toHaveBeenCalledWith('a.md', 'the quick brown fox', [{ path: 'target.md', text: 'target text' }]);
        expect(host.relationExtractor.extractRelations).toHaveBeenCalledWith('prompt', 'a.md');
        expect(host.relationStore.upsertEdges).toHaveBeenCalledWith('a.md', expect.any(Array), true);
        expect(input.afterPersist).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ target: 'target.md' })]),
            null
        );
        expect(res.madeNetworkCall).toBe(true);
        expect(host.vectorStore.recordDimension).toHaveBeenCalledWith(2);
    });

    it('persists an empty marker for blank text and short-circuits everything', async () => {
        const host = makeHost();
        const input = makeInput({ extractText: vi.fn(async () => ({ text: '   ', madeNetworkCall: false })) });

        const res = await new IndexFileFlow(host).index(input);

        expect(host.vectorStore.upsert).toHaveBeenCalledWith('a.md', []);
        expect(host.hybridRetriever.retrieve).not.toHaveBeenCalled();
        expect(input.afterPersist).not.toHaveBeenCalled();
        expect(input.onNoRelations).not.toHaveBeenCalled();
        expect(res.madeNetworkCall).toBe(false);
    });

    it('skips absent documents entirely, without persisting a marker', async () => {
        const host = makeHost();
        const input = makeInput({ extractText: vi.fn(async () => ({ text: '', madeNetworkCall: false, absent: true })) });

        await new IndexFileFlow(host).index(input);

        expect(host.vectorStore.upsert).not.toHaveBeenCalled();
        expect(host.hybridRetriever.retrieve).not.toHaveBeenCalled();
    });

    it('short-circuits when the stored content hash matches', async () => {
        const text = 'the quick brown fox';
        const matchingHash = await hashString(text);
        const host = makeHost();
        host.vectorStore.getFileHash = vi.fn(() => matchingHash);
        const input = makeInput({ extractText: vi.fn(async () => ({ text, madeNetworkCall: false })) });

        await new IndexFileFlow(host).index(input);

        expect(host.embeddingPipeline.embed).not.toHaveBeenCalled();
        expect(host.vectorStore.upsert).not.toHaveBeenCalled();
        expect(host.hybridRetriever.retrieve).not.toHaveBeenCalled();
    });

    it('reuses unchanged chunk vectors and merges partial-update edges', async () => {
        const unchangedText = 'first chunk unchanged';
        const changedText = 'second chunk changed';
        const unchangedHash = await hashString(unchangedText);
        const host = makeHost();
        host.vectorStore.getChunks = vi.fn(() => [{ chunkHash: unchangedHash, embedding: [1, 2] }]);
        host.relationStore.getEdgesForPath = vi.fn(() => [{ source: 'a.md', target: 'keep.md', relationType: 'related' }]);
        host.embeddingPipeline.chunkText = vi.fn(() => [unchangedText, changedText]);
        host.embeddingPipeline.embed = vi.fn(async () => [3, 4]);

        const input = makeInput();
        await new IndexFileFlow(host).index(input);

        // Only the genuinely changed chunk hits the embed function.
        expect(host.embeddingPipeline.embed).toHaveBeenCalledTimes(1);
        // The changed excerpt is what gets fed to the lexical query / prompt.
        expect(input.promptSource).toHaveBeenCalledWith('the quick brown fox', [changedText], true);
        expect(input.mergeOnPartial).toHaveBeenCalledWith(
            [expect.objectContaining({ target: 'keep.md' })],
            expect.any(Array)
        );
        expect(host.vectorStore.upsert).toHaveBeenCalledWith(
            'a.md',
            expect.arrayContaining([expect.objectContaining({ text: unchangedText, embedding: [1, 2] })])
        );
    });

    it('re-embeds stored vectors whose dimension differs from the current model', async () => {
        const unchangedText = 'first chunk unchanged';
        const unchangedHash = await hashString(unchangedText);
        const host = makeHost();
        // The store knows the current model produces 3-dim vectors.
        host.vectorStore.dimension = 3;
        host.vectorStore.getChunks = vi.fn(() => [{ chunkHash: unchangedHash, embedding: [1, 2] }]);
        host.embeddingPipeline.chunkText = vi.fn(() => [unchangedText]);
        host.embeddingPipeline.embed = vi.fn(async () => [1, 2, 3]);

        await new IndexFileFlow(host).index(makeInput());

        // Matching text but wrong dimension ⇒ not reusable, re-embedded.
        expect(host.embeddingPipeline.embed).toHaveBeenCalledTimes(1);
        expect(host.vectorStore.recordDimension).toHaveBeenCalledWith(3);
    });

    it('reports hadAnchor=true when similar candidates are empty', async () => {
        const host = makeHost();
        host.hybridRetriever.retrieve = vi.fn(async () => []);
        const input = makeInput();

        await new IndexFileFlow(host).index(input);

        expect(input.onNoRelations).toHaveBeenCalledWith('the quick brown fox', true);
        expect(host.relationStore.upsertEdges).not.toHaveBeenCalled();
    });

    it('reports hadAnchor=false when the document has no anchoring vector', async () => {
        const host = makeHost();
        host.embeddingPipeline.chunkText = vi.fn(() => []);
        const input = makeInput();

        await new IndexFileFlow(host).index(input);

        expect(input.onNoRelations).toHaveBeenCalledWith('the quick brown fox', false);
        expect(host.hybridRetriever.retrieve).not.toHaveBeenCalled();
    });
});

describe('VaultFileInput', () => {
    function makeVaultHost(): { host: VaultFileHost; spies: Record<string, ReturnType<typeof vi.fn>> } {
        const target = new TFile() as any;
        target.path = 'target.md';
        const host = {
            app: {
                vault: {
                    adapter: { exists: vi.fn(async () => true) },
                    getAbstractFileByPath: vi.fn(() => target),
                },
            },
            parser: {
                parse: vi.fn(async () => ({ cleanText: 'note content' })),
                parsePdf: vi.fn(async () => 'pdf text'),
            },
            localOcr: { hasText: vi.fn(async () => true) },
            visionExtractor: { extractImageText: vi.fn(async () => 'image text') },
            scoringEngine: {
                calculateOverallScore: vi.fn((_f, _t, cosine, confidence) => ({ overall: confidence, llm: confidence, cosine })),
            },
            backlinkManager: { processEdges: vi.fn(async () => {}) },
            userProfileManager: { addInsight: vi.fn(async () => {}), addActivity: vi.fn(async () => {}) },
        };
        return { host: host as any, spies: host as any };
    }

    function makeFile(name = 'note.md'): TFile {
        const f = new TFile() as any;
        f.path = name;
        f.extension = name.split('.').pop();
        f.basename = name.split('.')[0];
        return f;
    }

    it('extracts markdown clean text', async () => {
        const { host } = makeVaultHost();
        const input = new VaultFileInput(host, makeFile());
        expect((await input.extractText()).text).toBe('note content');
    });

    it('extracts image text via vision when OCR detects text', async () => {
        const { host } = makeVaultHost();
        const input = new VaultFileInput(host, makeFile('photo.png'));
        const res = await input.extractText();
        expect(res.text).toBe('image text');
        expect(res.madeNetworkCall).toBe(true);
    });

    it('marks absent files instead of producing text', async () => {
        const { host } = makeVaultHost();
        host.app.vault.adapter.exists = vi.fn(async () => false);
        const input = new VaultFileInput(host, makeFile());
        expect(await input.extractText()).toEqual({ text: '', madeNetworkCall: false, absent: true });
    });

    it('scores edges through the scoring engine using the cosine similarity', async () => {
        const { host, spies } = makeVaultHost();
        const input = new VaultFileInput(host, makeFile());
        const edges = await input.score(
            [{ target: 'target.md', confidence: 0.8 }],
            [{ filePath: 'target.md', text: 'x', similarity: 0.71 }]
        );
        expect(spies.scoringEngine.calculateOverallScore).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0.71, 0.8);
        expect(edges[0].scores).toEqual({ overall: 0.8, llm: 0.8, cosine: 0.71 });
    });

    it('adds insight and processes backlinks after persisting markdown', async () => {
        const { host, spies } = makeVaultHost();
        const input = new VaultFileInput(host, makeFile());
        const edges = [{ target: 'target.md' }];
        await input.afterPersist(edges, 'insight text');
        expect(spies.userProfileManager.addInsight).toHaveBeenCalledWith('insight text');
        expect(spies.backlinkManager.processEdges).toHaveBeenCalledWith(expect.anything(), edges);
    });

    it('does not process backlinks for non-markdown notes', async () => {
        const { host, spies } = makeVaultHost();
        const input = new VaultFileInput(host, makeFile('photo.png'));
        await input.afterPersist([], null);
        expect(spies.userProfileManager.addInsight).not.toHaveBeenCalled();
        expect(spies.backlinkManager.processEdges).not.toHaveBeenCalled();
    });

    it('logs activity for markdown even without an anchor, but not for notes that would be busy', async () => {
        const { host, spies } = makeVaultHost();
        const md = new VaultFileInput(host, makeFile('note.md'));
        await md.onNoRelations('text', false);
        expect(spies.userProfileManager.addActivity).toHaveBeenCalledWith('text');
        spies.userProfileManager.addActivity.mockClear();

        const img = new VaultFileInput(host, makeFile('photo.png'));
        await img.onNoRelations('text', false);
        expect(spies.userProfileManager.addActivity).not.toHaveBeenCalled();

        await img.onNoRelations('text', true);
        expect(spies.userProfileManager.addActivity).toHaveBeenCalledWith('text');
    });
});

describe('CalendarInput', () => {
    const event = {
        id: 'evt1',
        summary: 'Standup',
        description: 'Daily sync',
        start: { dateTime: '2026-01-01T10:00:00Z' },
        attendees: [{ email: 'a@x.com', displayName: 'Alice' }],
        htmlLink: '',
    };

    it('builds a description from the event and indexes under a virtual path', () => {
        const input = new CalendarInput(event as any);
        expect(input.path).toBe('gcal://evt1');
        const text = (input.extractText() as any).text;
        expect(text).toContain('Standup');
        expect(text).toContain('Daily sync');
        expect(text).toContain('Alice');
    });

    it('applies flat confidence scores (no scoring engine)', async () => {
        const input = new CalendarInput(event as any);
        const scored = await input.score([{ target: 'x.md', confidence: 0.7 }]);
        expect(scored[0].scores).toEqual({ overall: 0.7, llm: 0.7, cosine: 0, keyword: 0, folder: 0, recency: 0 });
    });

    it('replaces edges on partial re-index and has no side effects', async () => {
        const input = new CalendarInput(event as any);
        expect(input.mergeOnPartial([{ target: 'old.md' }], [{ target: 'new.md' }])).toEqual([{ target: 'new.md' }]);
        await expect(input.afterPersist([], null)).resolves.toBeUndefined();
        await expect(input.onNoRelations('text', true)).resolves.toBeUndefined();
    });
});