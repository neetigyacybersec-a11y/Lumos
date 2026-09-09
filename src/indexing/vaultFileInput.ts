import { Logger } from '../logger';
import { TFile } from 'obsidian';
import { IMAGE_EXTENSIONS } from '../utils';
import { mergeEdges } from './stages';
import { IndexInput, ExtractResult } from './indexFileFlow';

/**
 * The vault-file slice of the index pipeline (text extraction, scoring,
 * backlinks, activity). Structurally satisfied by LumosPlugin.
 */
export interface VaultFileHost {
    app: {
        vault: {
            adapter: { exists(path: string): Promise<boolean> };
            getAbstractFileByPath(path: string): any;
        };
    };
    parser: {
        parse(file: TFile): Promise<{ cleanText: string }>;
        parsePdf(file: TFile): Promise<string>;
    };
    localOcr: { hasText(file: TFile): Promise<boolean> };
    visionExtractor: { extractImageText(file: TFile): Promise<string> };
    scoringEngine: {
        calculateOverallScore(file: TFile, target: TFile, cosine: number, confidence: number): any;
    };
    backlinkManager: { processEdges(file: TFile, edges: any[]): Promise<void> };
    userProfileManager: { addInsight(insight: string): Promise<void>; addActivity(text: string): Promise<void> };
}

/**
 * IndexInput strategy for real vault files: md notes, PDFs and images (via
 * OCR + vision). The only caller of `app.vault.adapter.exists`/parser/OCR.
 */
export class VaultFileInput implements IndexInput {
    readonly path: string;
    private readonly isMarkdown: boolean;

    constructor(private readonly host: VaultFileHost, private readonly file: TFile) {
        this.path = file.path;
        this.isMarkdown = file.extension.toLowerCase() === 'md';
    }

    async extractText(): Promise<ExtractResult> {
        // Check if file was somehow deleted while waiting
        if (!(await this.host.app.vault.adapter.exists(this.file.path))) {
            return { text: '', madeNetworkCall: false, absent: true };
        }

        const ext = this.file.extension.toLowerCase();
        if (ext === 'md') {
            const parsed = await this.host.parser.parse(this.file);
            return { text: parsed.cleanText, madeNetworkCall: false };
        }
        if (ext === 'pdf') {
            try {
                return { text: await this.host.parser.parsePdf(this.file), madeNetworkCall: false };
            } catch (e) {
                Logger.error(`Failed to parse PDF ${this.file.path}`, e);
                return { text: '', madeNetworkCall: false };
            }
        }
        if (IMAGE_EXTENSIONS.includes(ext)) {
            try {
                const hasText = await this.host.localOcr.hasText(this.file);
                if (hasText) {
                    return { text: await this.host.visionExtractor.extractImageText(this.file), madeNetworkCall: true };
                }
                return { text: '', madeNetworkCall: false };
            } catch (e) {
                Logger.error(`Failed OCR on Image ${this.file.path}`, e);
                return { text: '', madeNetworkCall: false };
            }
        }
        return { text: '', madeNetworkCall: false };
    }

    promptSource(text: string, changedChunkTexts: string[], isPartialUpdate: boolean): string {
        // On a partial edit, only send the changed excerpts to the LLM
        // instead of the whole file (#incremental-edit).
        return isPartialUpdate ? changedChunkTexts.join('\n\n') : text;
    }

    async score(edges: any[], similar: { filePath: string; text: string; similarity: number }[]): Promise<any[]> {
        return edges.map(edge => {
            const targetFile = this.host.app.vault.getAbstractFileByPath(edge.target);
            if (!(targetFile instanceof TFile)) return edge;

            const simMatch = similar.find(s => s.filePath === edge.target);
            const cosine = simMatch ? simMatch.similarity : 0;
            return { ...edge, scores: this.host.scoringEngine.calculateOverallScore(this.file, targetFile, cosine, edge.confidence) };
        });
    }

    mergeOnPartial(existing: any[], scored: any[]): any[] {
        return mergeEdges(existing, scored);
    }

    async afterPersist(edges: any[], profileInsights: string | null): Promise<void> {
        if (profileInsights) {
            await this.host.userProfileManager.addInsight(profileInsights);
        }
        if (this.isMarkdown) {
            await this.host.backlinkManager.processEdges(this.file, edges);
        }
    }

    async onNoRelations(text: string, hadAnchor: boolean): Promise<void> {
        if (!hadAnchor && !this.isMarkdown) return;
        await this.host.userProfileManager.addActivity(text);
    }
}