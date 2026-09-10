import { Logger } from './logger';
import type { CacheVaultLike } from './visionCache';

export interface BeautifyBlockRecord {
    key: string;
    source: string;
    beautified: string;
    model: string;
    cachedAt: number;
}

export interface BeautifyNoteRecord {
    sourceHash: string;
    wholeBeautified?: string;
    model: string;
    optsHash: string;
    updatedAt: number;
    blocks: BeautifyBlockRecord[];
}

const MAX_NOTES = 100;
const MAX_BLOCKS_PER_NOTE = 200;

export class BeautifyCache {
    private records = new Map<string, BeautifyNoteRecord>();
    private dataFile = 'beautify-cache.json';
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
            const records = new Map<string, BeautifyNoteRecord>(Object.entries(parsed || {}));
            for (const [, record] of records) {
                if (!Array.isArray(record.blocks)) record.blocks = [];
            }
            this.records = records;
        } catch (e) {
            this.records = new Map();
        }
    }

    getNote(path: string): BeautifyNoteRecord | null {
        return this.records.get(path) || null;
    }

    setWhole(
        path: string,
        whole: Omit<BeautifyNoteRecord, 'updatedAt' | 'blocks'>
    ): void {
        const existing = this.records.get(path);
        this.records.set(path, {
            sourceHash: whole.sourceHash,
            wholeBeautified: whole.wholeBeautified,
            model: whole.model,
            optsHash: whole.optsHash,
            updatedAt: Date.now(),
            blocks: existing?.blocks ?? [],
        });
        this.prune();
        void this.save();
    }

    invalidateNote(path: string, skipSave = false): void {
        if (!this.records.delete(path)) return;
        if (!skipSave) void this.save();
    }

    getBlock(path: string, key: string): BeautifyBlockRecord | null {
        const record = this.records.get(path);
        if (!record) return null;
        const block = record.blocks.find((b) => b.key === key);
        return block ?? null;
    }

    setBlock(path: string, block: BeautifyBlockRecord): void {
        let record = this.records.get(path);
        if (!record) {
            record = { sourceHash: '', model: block.model, optsHash: '', updatedAt: Date.now(), blocks: [] };
            this.records.set(path, record);
        }
        const index = record.blocks.findIndex((b) => b.key === block.key);
        if (index >= 0) record.blocks[index] = block;
        else record.blocks.push(block);
        if (record.blocks.length > MAX_BLOCKS_PER_NOTE) {
            record.blocks.sort((a, b) => a.cachedAt - b.cachedAt);
            record.blocks = record.blocks.slice(record.blocks.length - MAX_BLOCKS_PER_NOTE);
        }
        record.updatedAt = Date.now();
        this.prune();
        void this.save();
    }

    private prune(): void {
        if (this.records.size <= MAX_NOTES) return;
        const byAge = [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        const overflow = byAge.slice(0, byAge.length - MAX_NOTES);
        for (const record of overflow) {
            for (const [path, candidate] of this.records) {
                if (candidate === record) this.records.delete(path);
            }
        }
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
            await adapter.write(tempPath, JSON.stringify(Object.fromEntries(this.records)));
            if (await adapter.exists(finalPath)) await adapter.remove(finalPath);
            await adapter.rename(tempPath, finalPath);
        } catch (e) {
            Logger.error('Failed to save beautify cache', e);
        } finally {
            this.isSaving = false;
            if (this.savePending) void this.forceSave();
        }
    }

    async clear(skipSave = false): Promise<void> {
        this.records.clear();
        if (!skipSave) await this.save();
    }
}