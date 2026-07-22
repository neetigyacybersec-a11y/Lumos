import { Logger } from './logger';
import { Plugin } from 'obsidian';

export interface RelationEdge {
    source: string;
    target: string;
    relationType: 'duplicate-effort' | 'prerequisite' | 'contradicts' | 'extends' | 'thematic-only';
    confidence: number; // LLM confidence
    evidence: string;
    scores?: {
        llm: number;
        cosine: number;
        keyword: number;
        folder: number;
        recency: number;
        overall: number;
    };
    dismissed?: boolean;
}

export class RelationStore {
    private plugin: Plugin;
    private edges: RelationEdge[] = [];
    private dataFile = 'relations.json';
    private saveTimeout: any = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load() {
        const manifestDir = this.plugin.manifest?.dir || '';
        const data = await this.plugin.app.vault.adapter.read(`${manifestDir}/${this.dataFile}`).catch(() => '[]');
        try {
            this.edges = JSON.parse(data);
        } catch (e) {
            this.edges = [];
        }
    }

    async save() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(async () => {
            await this.forceSave();
        }, 1000);
    }

    private isSaving = false;
    private savePending = false;

    async forceSave() {
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
        
        const manifestDir = this.plugin.manifest?.dir || '';
        const tempPath = `${manifestDir}/${this.dataFile}.tmp`;
        const finalPath = `${manifestDir}/${this.dataFile}`;
        
        try {
            await this.plugin.app.vault.adapter.write(tempPath, JSON.stringify(this.edges));
            if (await this.plugin.app.vault.adapter.exists(finalPath)) {
                await this.plugin.app.vault.adapter.remove(finalPath);
            }
            await this.plugin.app.vault.adapter.rename(tempPath, finalPath);
        } catch (e) {
            Logger.error('Failed to save relations', e);
        } finally {
            this.isSaving = false;
            if (this.savePending) {
                this.forceSave();
            }
        }
    }

    async upsertEdges(sourcePath: string, newEdges: RelationEdge[], skipSave: boolean = false) {
        // Preserve dismissed state
        const existingEdges = this.edges.filter(e => e.source === sourcePath);
        for (const newEdge of newEdges) {
            const existing = existingEdges.find(e => e.target === newEdge.target && e.relationType === newEdge.relationType);
            if (existing && existing.dismissed) {
                newEdge.dismissed = true;
            }
        }
        
        this.edges = this.edges.filter(e => e.source !== sourcePath);
        this.edges.push(...newEdges);
        if (!skipSave) await this.save();
    }

    async deleteEdges(sourcePath: string, skipSave: boolean = false) {
        const initial = this.edges.length;
        this.edges = this.edges.filter(e => e.source !== sourcePath && e.target !== sourcePath);
        if (this.edges.length !== initial && !skipSave) {
            await this.save();
        }
    }

    async dismissEdge(sourcePath: string, targetPath: string, relationType: string, skipSave: boolean = false) {
        let changed = false;
        for (const e of this.edges) {
            if (e.source === sourcePath && e.target === targetPath && e.relationType === relationType) {
                e.dismissed = true;
                changed = true;
            }
        }
        if (changed && !skipSave) await this.save();
    }

    async renameFile(oldPath: string, newPath: string, skipSave: boolean = false) {
        let changed = false;
        for (const e of this.edges) {
            if (e.source === oldPath) {
                e.source = newPath;
                changed = true;
            }
            if (e.target === oldPath) {
                e.target = newPath;
                changed = true;
            }
        }
        if (changed && !skipSave) await this.save();
    }

    async clear(skipSave: boolean = false) {
        this.edges = [];
        if (!skipSave) await this.save();
    }

    getEdgesForPath(path: string): RelationEdge[] {
        return this.edges.filter(e => e.source === path || e.target === path);
    }
}
