import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import * as obsidian from 'obsidian';
import { BackgroundIndexer } from '../src/indexer';
import { VectorStore } from '../src/vectorStore';
import { readManifest, writeManifest, manifestNeedsRebuild, SCHEMA_VERSION } from '../src/indexManifest';

// ---------------------------------------------------------------------------
// Pure manifest logic
// ---------------------------------------------------------------------------

describe('manifestNeedsRebuild', () => {
    const base = {
        schemaVersion: SCHEMA_VERSION,
        embeddingModel: 'openai/text-embedding-3-small',
        pluginVersion: '1.0.0',
        createdAt: 1,
        updatedAt: 1,
    };

    it('is false when the manifest is absent (never rebuilt)', () => {
        expect(manifestNeedsRebuild(null, 'openai/text-embedding-3-small')).toBe(false);
    });

    it('is false when model and schema match, even after a plugin version bump', () => {
        const bumped = { ...base, pluginVersion: '1.1.0' };
        expect(manifestNeedsRebuild(bumped, 'openai/text-embedding-3-small')).toBe(false);
    });

    it('is true when the embedding model changed', () => {
        expect(manifestNeedsRebuild(base, 'openai/text-embedding-3-large')).toBe(true);
    });

    it('is true when the schema version changed', () => {
        expect(manifestNeedsRebuild({ ...base, schemaVersion: SCHEMA_VERSION + 1 }, base.embeddingModel)).toBe(true);
    });
});

describe('readManifest / writeManifest', () => {
    const memory = new Map<string, string>();
    const adapter = {
        exists: async (p: string) => memory.has(p),
        read: async (p: string) => memory.get(p)!,
        write: async (p: string, d: string) => { memory.set(p, d); },
        remove: async () => {},
        rename: async () => {},
    };
    const plugin = {
        manifest: { dir: '/plugin-dir', version: '1.0.0' } as { dir?: string; version?: string },
    };

    beforeEach(() => memory.clear());

    it('round-trips a manifest, preserving createdAt on rewrite', async () => {
        await writeManifest(plugin, adapter as any, 'm1');
        const first = await readManifest(plugin, adapter as any);
        expect(first?.embeddingModel).toBe('m1');
        expect(first?.schemaVersion).toBe(SCHEMA_VERSION);
        const createdAt = first?.createdAt;

        await writeManifest(plugin, adapter as any, 'm2');
        const second = await readManifest(plugin, adapter as any);
        expect(second?.embeddingModel).toBe('m2');
        expect(second?.createdAt).toBe(createdAt);
    });

    it('returns null when no manifest file exists', async () => {
        expect(await readManifest(plugin, adapter as any)).toBeNull();
    });

    it('returns null when the plugin dir is unknown (no persistence)', async () => {
        expect(await readManifest({ manifest: {} } as any, adapter as any)).toBeNull();
        await expect(writeManifest({ manifest: {} } as any, adapter as any, 'm')).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// BackgroundIndexer.start() gating
// ---------------------------------------------------------------------------

function makeHost(overrides: {
    loadFailed?: boolean;
    indexedFiles?: string[];
    contents?: Record<string, string>;
}): { plugin: any; indexer: BackgroundIndexer } {
    const { loadFailed = false, indexedFiles = [], contents = {} } = overrides;
    const contentsMap = new Map(Object.entries(contents));
    const manifestStore = new Map<string, string>();

    const vectorStore = new VectorStore(null as any);
    vectorStore.loadFailed = loadFailed;
    for (const p of indexedFiles) {
        vectorStore.indexedFiles.add(p);
    }
    (vectorStore as any).hasFile = (p: string) => vectorStore.indexedFiles.has(p);

    const plugin: any = {
        manifest: {},
        settings: {
            userProfilePath: 'User_Profile_AI.md',
            ignoredFolders: '',
            googleSyncEnabled: false,
            googleRefreshToken: '',
            embeddingModelName: 'openai/text-embedding-3-small',
        },
        app: {
            vault: {
                getFiles: () => Object.keys(contentsMap).map((p) => {
                    const f = new TFile() as any;
                    f.path = p;
                    f.name = p.split('/').pop();
                    f.extension = p.split('.').pop();
                    f.stat = { mtime: Date.now() };
                    return f;
                }),
                adapter: {
                    exists: async (p: string) => contentsMap.has(p) || manifestStore.has(p),
                    read: async (p: string) => manifestStore.get(p) ?? contentsMap.get(p) ?? '',
                    write: async (p: string, d: string) => { manifestStore.set(p, d); },
                },
            },
            workspace: { getLeavesOfType: () => [] },
        },
        relationStore: { forceSave: async () => {} },
        userProfileManager: { pauseUpdates: () => {}, resumeUpdates: () => {}, flush: async () => {} },
        vectorStore,
    };

    const indexer = new BackgroundIndexer(plugin);
    return { plugin, indexer };
}

describe('BackgroundIndexer.start() gating', () => {
    it('does not queue any files for rehash when the index failed to load', async () => {
        const { indexer } = makeHost({ loadFailed: true, contents: { 'a.md': 'text' } });
        await indexer.start();
        // The failed load must not be treated as an empty vault: nothing queued.
        expect(indexer.queue).toHaveLength(0);
        expect(indexer.totalFiles).toBe(0);
    });

    it('does not requeue already-indexed files when the model differs (notifies without rehashing)', async () => {
        const { indexer } = makeHost({
            indexedFiles: ['a.md'],
            contents: { 'a.md': 'text' },
        });
        await indexer.start();
        // Indexed file must not be requeued.
        expect(indexer.queue).toHaveLength(0);
    });

    it('notifies when the stored manifest differs from the current embedding model', async () => {
        const { plugin, indexer } = makeHost({
            indexedFiles: ['a.md'],
            contents: { 'a.md': 'text' },
        });
        plugin.manifest = { dir: '/plugin-dir' };
        const adapter = plugin.app.vault.adapter;
        await writeManifest(plugin, adapter, 'other/embedding-model');
        // Change the current model away from what the manifest records.
        plugin.settings.embeddingModelName = 'openai/text-embedding-3-small-large';

        const noticeSpy = vi.spyOn(obsidian, 'Notice');
        await indexer.start();

        expect(noticeSpy).toHaveBeenCalled();
        expect(indexer.queue).toHaveLength(0);
        noticeSpy.mockRestore();
    });
});
