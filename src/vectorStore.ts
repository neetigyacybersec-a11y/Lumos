import { Plugin } from 'obsidian';

export interface VectorChunk {
    id: string; // filePath#chunkIndex
    filePath: string;
    text: string;
    embedding: number[];
    contentHash?: string;
}

const DB_NAME = 'LumosDB';
const DB_VERSION = 1;
const STORE_NAME = 'vectors';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('filePath', 'filePath', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export class VectorStore {
    private plugin: Plugin;
    private vectors: VectorChunk[] = [];
    private indexedFiles: Set<string> = new Set();
    private db: IDBDatabase | null = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load() {
        try {
            this.db = await openDB();
            
            // Load all vectors into memory for fast querying
            return new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();
                
                request.onsuccess = () => {
                    this.vectors = request.result || [];
                    this.indexedFiles = new Set(this.vectors.map(v => v.filePath));
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('Failed to load VectorStore from IndexedDB', e);
            this.vectors = [];
            this.indexedFiles = new Set();
        }
    }

    async upsert(filePath: string, chunks: VectorChunk[]) {
        // Update memory
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        if (chunks.length > 0) {
            this.vectors.push(...chunks);
        }
        this.indexedFiles.add(filePath);

        // Update IndexedDB
        if (this.db) {
            return new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const index = store.index('filePath');
                const keyReq = index.getAllKeys(filePath);
                
                keyReq.onsuccess = () => {
                    const keys = keyReq.result;
                    for (const key of keys) {
                        store.delete(key);
                    }
                    for (const chunk of chunks) {
                        store.put(chunk);
                    }
                };
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        }
    }

    async delete(filePath: string) {
        // Update memory
        this.vectors = this.vectors.filter(v => v.filePath !== filePath);
        this.indexedFiles.delete(filePath);

        // Update IndexedDB
        if (this.db) {
            return new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const index = store.index('filePath');
                const keyReq = index.getAllKeys(filePath);
                
                keyReq.onsuccess = () => {
                    const keys = keyReq.result;
                    for (const key of keys) {
                        store.delete(key);
                    }
                };
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        }
    }

    async renameFile(oldPath: string, newPath: string) {
        // Update memory
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

        // Update IndexedDB
        if (this.db && changed) {
            return new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const index = store.index('filePath');
                const req = index.getAll(oldPath);
                
                req.onsuccess = () => {
                    const records = req.result as VectorChunk[];
                    for (const record of records) {
                        store.delete(record.id); // Delete old record
                        record.filePath = newPath;
                        record.id = record.id.replace(oldPath, newPath);
                        store.put(record); // Insert new record
                    }
                };
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        }
    }

    async clear() {
        this.vectors = [];
        this.indexedFiles.clear();

        if (this.db) {
            return new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                store.clear();
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        }
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

    async querySimilar(embedding: number[], topK: number = 5, excludeFilePath?: string): Promise<(VectorChunk & { similarity: number })[]> {
        const fileMaxSim = new Map<string, VectorChunk & { similarity: number }>();

        for (let i = 0; i < this.vectors.length; i++) {
            const v = this.vectors[i];
            
            // Yield to main thread every 500 items to prevent UI freezing
            if (i > 0 && i % 500 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }

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
