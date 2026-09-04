import { PluginSettings, ParsedNote } from './types';
import { TFile } from 'obsidian';

/**
 * Narrow structural ports that break the import cycles around main.ts.
 *
 * Core (non-UI) modules declare the slice of LumosPlugin they actually need
 * and depend on these interfaces instead of importing the plugin class.
 * LumosPlugin satisfies every port structurally, so main.ts stays the sole
 * composition root with zero adapter code. Views and the settings tab are
 * UI-layer exceptions: they keep holding LumosPlugin directly.
 */

export interface LogSink {
    manifest?: { dir?: string };
    app: {
        vault: {
            adapter: {
                exists(path: string): Promise<boolean>;
                read(path: string): Promise<string>;
                write(path: string, data: string): Promise<void>;
            };
        };
    };
}

export interface WatcherHost {
    app: {
        vault: {
            on(name: string, cb: (...args: any[]) => any): any;
            offref(ref: any): void;
        };
    };
    logActivity(message: string): void;
}

export interface IndexerHost {
    manifest?: { dir?: string; version?: string };
    settings: Pick<PluginSettings, 'userProfilePath' | 'ignoredFolders' | 'googleSyncEnabled' | 'googleRefreshToken' | 'embeddingModelName'>;
    app: {
        vault: {
            getFiles(): TFile[];
            getAbstractFileByPath(path: string): any;
            create(path: string, data: string): Promise<any>;
            adapter: { exists(path: string): Promise<boolean> };
        };
        workspace: { getLeavesOfType(type: string): any[] };
    };
    parser: {
        parse(file: TFile): Promise<ParsedNote>;
        parsePdf(file: TFile): Promise<string>;
    };
    vectorStore: {
        hasFile(filePath: string): boolean;
        getFileHash(filePath: string): string | undefined;
        getChunks(filePath: string): { chunkHash?: string; embedding: number[] }[];
        upsert(filePath: string, chunks: any[]): Promise<void>;
        getFileCount(): number;
    };
    embeddingPipeline: {
        chunkText(text: string): string[];
        embed(text: string): Promise<number[]>;
    };
    relationExtractor: {
        constructPrompt(sourcePath: string, sourceText: string, candidates: { path: string; text: string }[]): string;
        extractRelations(prompt: string, sourcePath: string): Promise<{ edges: any[]; profileInsights: string | null }>;
    };
    relationStore: {
        getEdgesForPath(path: string): any[];
        upsertEdges(sourcePath: string, edges: any[], skipSave?: boolean): Promise<void>;
        forceSave(): Promise<void>;
    };
    userProfileManager: {
        pauseUpdates(): void;
        resumeUpdates(): void;
        flush(): Promise<void>;
        addInsight(insight: string): Promise<void>;
        addActivity(text: string): Promise<void>;
    };
    backlinkManager: { processEdges(file: TFile, edges: any[]): Promise<void> };
    scoringEngine: {
        calculateOverallScore(file: TFile, target: TFile, cosine: number, confidence: number): any;
    };
    hybridRetriever: {
        retrieve(opts: {
            queryVector?: number[];
            lexicalQuery?: string;
            topK: number;
            excludeFilePath?: string;
            skipRerank?: boolean;
        }): Promise<{ filePath: string; text: string; similarity: number }[]>;
    };
    localOcr: { hasText(file: TFile): Promise<boolean> };
    visionExtractor: { extractImageText(file: TFile): Promise<string> };
}

export interface RetrievalHost {
    settings: Pick<PluginSettings, 'enableHybridSearch' | 'rerankerModel' | 'rerankCandidates'>;
    embeddingPipeline: { embed(text: string): Promise<number[]> };
    vectorStore: {
        querySimilar(embedding: number[], topK?: number, excludeFilePath?: string): Promise<
            { filePath: string; text: string; similarity: number }[]
        >;
    };
}

export interface RelationExtractorHost {
    llmService: { callLLM(messages: { role: string; content: string }[], isRouting?: boolean, expectJson?: boolean): Promise<string> };
}

export interface LLMServiceHost {
    settings: ProviderSettingsShape;
}

export type ProviderSettingsShape = Pick<PluginSettings, 'provider' | 'baseUrl' | 'apiKey' | 'llmModelName' | 'embeddingModelName' | 'visionModelName' | 'requestTimeoutSec'>;

export interface ProfileHost {
    app: AppLike;
    settings: Pick<PluginSettings, 'enableUserProfile' | 'userProfilePath' | 'userProfileWordThreshold'>;
    llmService: { callLLM(messages: { role: string; content: string }[], isRouting?: boolean, expectJson?: boolean): Promise<string> };
}

export interface AppLike {
    vault: {
        read(file: TFile): Promise<string>;
        process(file: TFile, fn: (data: string) => string): Promise<void>;
        create(path: string, data: string): Promise<any>;
        getAbstractFileByPath(path: string): any;
    };
}

export interface GoogleHost {
    settings: Pick<PluginSettings, 'googleClientId' | 'googleClientSecret' | 'googleRefreshToken' | 'googleSyncEnabled'>;
    saveSettings(): Promise<void>;
}
