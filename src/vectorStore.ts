import { Plugin } from 'obsidian';

export interface VectorChunk {
    id: string; // filePath#chunkIndex
    filePath: string;
    text: string;
    embedding: number[];
    contentHash?: string;
}

export class VectorStore {
    private plugin: Plugin;
    private vectors: VectorChunk[] = [];
    private indexedFiles: Set<string> = new Set();
    private dataFile = 'vectors.json';
    private saveTimeout: any = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load() {
        const manifestDir = this.plugin.manifest?.dir || '';
        const data = await this.plugin.app.vault.adapter.read(`${manifestDir}/${this.dataFile}`).catch(() => '[]');
        try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                this.vectors = parsed;
                this.indexedFiles = new Set(this.vectors.map(v => v.filePath));
            } else {
                this.vectors = parsed.vectors || [];
                this.indexedFiles = new Set(parsed.indexedFiles || this.vectors.map(v => v.filePath));
            }
        } catch (e) {
            this.vectors = [];
            this.indexedFiles = new Set();
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

    async forceSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        const manifestDir = this.plugin.manifest?.dir || '';
        try {
            const payload = {
                vectors: this.vectors,
                indexedFiles: Array.from(this.indexedFiles)
            };
            await this.plugin.app.vault.adapter.write(`${manifestDir}/${this.dataFile}`, JSON.stringify(payload));
        } catch (e) {
            console.error('Failed to save vectors', e);
        }
    }

    async upsert(filePath: string, chunks: VectorChunk[], skipSave: boolean = false) {
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        if (chunks.length > 0) {
            this.vectors.push(...chunks);
        }
        this.indexedFiles.add(filePath);
        if (!skipSave) await this.save();
    }

    async delete(filePath: string, skipSave: boolean = false) {
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        this.indexedFiles.delete(filePath);
        if (!skipSave) await this.save();
    }

    async renameFile(oldPath: string, newPath: string, skipSave: boolean = false) {
        let changed = false;
        for (const v of this.vectors) {
            if (v.filePath === oldPath) {
                v.filePath = newPath;
                v.id = v.id.replace(oldPath, newPath);
                changed = true;
            }
        }
        if (this.indexedFiles.has(oldPath)) {
            this.indexedFiles.delete(oldPath);
            this.indexedFiles.add(newPath);
            changed = true;
        }
        if (changed && !skipSave) await this.save();
    }

    async clear(skipSave: boolean = false) {
        this.vectors = [];
        this.indexedFiles.clear();
        if (!skipSave) await this.save();
    }

    hasFile(filePath: string): boolean {
        return this.indexedFiles.has(filePath);
    }

    getFileCount(): number {
        return this.indexedFiles.size;
    }

    getFileHash(filePath: string): string | undefined {
        const chunk = this.vectors.find(v => v.filePath === filePath && v.contentHash !== undefined);
        return chunk?.contentHash;
    }

    querySimilar(embedding: number[], topK: number = 5, excludeFilePath?: string): (VectorChunk & { similarity: number })[] {
        const fileMaxSim = new Map<string, VectorChunk & { similarity: number }>();

        for (const v of this.vectors) {
            if (v.filePath === excludeFilePath) continue;
            
            const similarity = cosineSimilarity(embedding, v.embedding);
            const existing = fileMaxSim.get(v.filePath);
            
            if (!existing || similarity > existing.similarity) {
                fileMaxSim.set(v.filePath, { ...v, similarity });
            }
        }

        const results = Array.from(fileMaxSim.values())
            .sort((a, b) => b.similarity - a.similarity);
            
        return results.slice(0, topK);
    }
}

export function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
    }
    // Assuming embeddings are pre-normalized, the dot product is the cosine similarity.
    // This avoids expensive Math.sqrt operations on the main UI thread.
    return dotProduct;
}
