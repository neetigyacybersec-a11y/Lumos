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
    private dataFile = 'vectors.json';
    private saveTimeout: any = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load() {
        const manifestDir = this.plugin.manifest?.dir || '';
        const data = await this.plugin.app.vault.adapter.read(`${manifestDir}/${this.dataFile}`).catch(() => '[]');
        try {
            this.vectors = JSON.parse(data);
        } catch (e) {
            this.vectors = [];
        }
    }

    async save() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(async () => {
            const manifestDir = this.plugin.manifest?.dir || '';
            // In real environments, adapter.write handles file creation
            // but for mocks we can just write it.
            try {
                await this.plugin.app.vault.adapter.write(`${manifestDir}/${this.dataFile}`, JSON.stringify(this.vectors));
            } catch (e) {
                console.error('Failed to save vectors', e);
            }
        }, 1000);
    }

    async upsert(filePath: string, chunks: VectorChunk[]) {
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        if (chunks.length > 0) {
            this.vectors.push(...chunks);
        }
        await this.save();
    }

    async delete(filePath: string) {
        const initialLen = this.vectors.length;
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        if (this.vectors.length !== initialLen) {
            await this.save();
        }
    }

    async renameFile(oldPath: string, newPath: string) {
        let changed = false;
        for (const v of this.vectors) {
            if (v.filePath === oldPath) {
                v.filePath = newPath;
                v.id = v.id.replace(oldPath, newPath);
                changed = true;
            }
        }
        if (changed) await this.save();
    }

    async clear() {
        this.vectors = [];
        await this.save();
    }

    hasFile(filePath: string): boolean {
        return this.vectors.some(v => v.filePath === filePath);
    }

    getFileCount(): number {
        const uniqueFiles = new Set(this.vectors.map(v => v.filePath));
        return uniqueFiles.size;
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
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
