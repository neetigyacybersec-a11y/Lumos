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
        const manifestDir = this.plugin.manifest?.dir || '';
        await this.plugin.app.vault.adapter.write(`${manifestDir}/${this.dataFile}`, JSON.stringify(this.edges));
    }

    async upsertEdges(sourcePath: string, newEdges: RelationEdge[]) {
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
        await this.save();
    }

    async deleteEdges(sourcePath: string) {
        const initial = this.edges.length;
        this.edges = this.edges.filter(e => e.source !== sourcePath && e.target !== sourcePath);
        if (this.edges.length !== initial) {
            await this.save();
        }
    }

    async dismissEdge(sourcePath: string, targetPath: string, relationType: string) {
        let changed = false;
        for (const e of this.edges) {
            if (e.source === sourcePath && e.target === targetPath && e.relationType === relationType) {
                e.dismissed = true;
                changed = true;
            }
        }
        if (changed) await this.save();
    }

    async renameFile(oldPath: string, newPath: string) {
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
        if (changed) await this.save();
    }

    async clear() {
        this.edges = [];
        await this.save();
    }

    getEdgesForPath(path: string): RelationEdge[] {
        return this.edges.filter(e => e.source === path || e.target === path);
    }
}
