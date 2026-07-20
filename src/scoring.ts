import { App, TFile } from 'obsidian';

export class ScoringEngine {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    private getFolder(path: string): string {
        const lastSlash = path.lastIndexOf('/');
        return lastSlash === -1 ? '' : path.substring(0, lastSlash);
    }

    private calculateFolderProximity(pathA: string, pathB: string): number {
        const folderA = this.getFolder(pathA);
        const folderB = this.getFolder(pathB);

        if (folderA === folderB) return 1.0;
        
        // Check if one is a direct parent of another
        if (folderA.startsWith(folderB + '/') || folderB.startsWith(folderA + '/')) {
            return 0.5;
        }

        return 0.0;
    }

    private calculateKeywordOverlap(fileA: TFile, fileB: TFile): number {
        const cacheA = this.app.metadataCache.getFileCache(fileA);
        const cacheB = this.app.metadataCache.getFileCache(fileB);

        const tagsA = new Set(cacheA?.tags?.map(t => t.tag) || []);
        const tagsB = new Set(cacheB?.tags?.map(t => t.tag) || []);

        if (tagsA.size === 0 && tagsB.size === 0) return 0.0;

        let intersection = 0;
        for (const tag of tagsA) {
            if (tagsB.has(tag)) intersection++;
        }

        const union = tagsA.size + tagsB.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    private calculateRecency(fileA: TFile, fileB: TFile): number {
        const diffMs = Math.abs(fileA.stat.mtime - fileB.stat.mtime);
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        
        // Decay function: 1.0 if modified at the same time, decays towards 0 over 30 days
        return Math.max(0, 1 - (diffDays / 30));
    }

    /**
     * Weights (User requested):
     * LLM: 40%
     * Cosine: 30%
     * Keyword: 10%
     * Folder: 10%
     * Recency: 10%
     */
    calculateOverallScore(source: TFile, target: TFile, cosineSim: number, llmConfidence: number) {
        // Cosine similarity from embeddings is usually between 0.0 and 1.0, sometimes negative but rare for related text.
        // Normalize cosine from [-1, 1] to [0, 1] if needed, but typically OpenAI/Ollama text embeddings are > 0.
        const normCosine = Math.max(0, cosineSim);
        
        const folder = this.calculateFolderProximity(source.path, target.path);
        const keyword = this.calculateKeywordOverlap(source, target);
        const recency = this.calculateRecency(source, target);

        const overall = (llmConfidence * 0.4) + (normCosine * 0.3) + (keyword * 0.1) + (folder * 0.1) + (recency * 0.1);

        return {
            llm: llmConfidence,
            cosine: normCosine,
            keyword,
            folder,
            recency,
            overall
        };
    }
}
