import { Logger } from './logger';

export interface VisionCacheEntry {
    path: string;
    mtime: number;
    size: number;
    model: string;
    text: string;
    cachedAt: number;
}

export interface VisionCacheableFile {
    path: string;
    stat: { mtime: number; size: number } | null;
}

export interface CacheAdapter {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
}

export interface CacheVaultLike {
    app: { vault: { adapter: CacheAdapter } };
    manifest?: { dir?: string } | null;
}

const MAX_ENTRIES = 200;

export class VisionCache {
    private entries = new Map<string, VisionCacheEntry>();
    private dataFile = 'vision-cache.json';
    private saveTimeout: any = null;
    private isSaving = false;
    private savePending = false;

    constructor(private plugin: CacheVaultLike) {}

    private get dir(): string {
        return this.plugin.manifest?.dir || '';
    }

    async load(): Promise<void> {
        const data = await this.plugin.app.vault.adapter
            .read(`${this.dir}/${this.dataFile}`)
            .catch(() => '{}');
        try {
            const parsed = JSON.parse(data || '{}');
            this.entries = new Map<string, VisionCacheEntry>(Object.entries(parsed || {}));
        } catch (e) {
            this.entries = new Map();
        }
    }

    get(file: VisionCacheableFile, model: string): string | null {
        if (!file.stat) return null;
        const entry = this.entries.get(file.path);
        if (!entry) return null;
        if (entry.model !== model) return null;
        if (entry.mtime !== file.stat.mtime || entry.size !== file.stat.size) return null;
        return entry.text;
    }

    set(file: VisionCacheableFile, model: string, text: string): void {
        const stat = file.stat;
        this.entries.set(file.path, {
            path: file.path,
            mtime: stat?.mtime ?? 0,
            size: stat?.size ?? 0,
            model,
            text,
            cachedAt: Date.now(),
        });
        this.prune();
        void this.save();
    }

    private prune(): void {
        if (this.entries.size <= MAX_ENTRIES) return;
        const byAge = [...this.entries.values()].sort((a, b) => a.cachedAt - b.cachedAt);
        const overflow = byAge.slice(0, byAge.length - MAX_ENTRIES);
        for (const entry of overflow) this.entries.delete(entry.path);
    }

    async save(): Promise<void> {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => void this.forceSave(), 1000);
    }

    async forceSave(): Promise<void> {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        if (this.isSaving) {
            this.savePending = true;
            return;
        }
        this.isSaving = true;
        this.savePending = false;

        const adapter = this.plugin.app.vault.adapter;
        const tempPath = `${this.dir}/${this.dataFile}.tmp`;
        const finalPath = `${this.dir}/${this.dataFile}`;

        try {
            await adapter.write(tempPath, JSON.stringify(Object.fromEntries(this.entries)));
            if (await adapter.exists(finalPath)) await adapter.remove(finalPath);
            await adapter.rename(tempPath, finalPath);
        } catch (e) {
            Logger.error('Failed to save vision cache', e);
        } finally {
            this.isSaving = false;
            if (this.savePending) void this.forceSave();
        }
    }

    async clear(skipSave = false): Promise<void> {
        this.entries.clear();
        if (!skipSave) await this.save();
    }
}