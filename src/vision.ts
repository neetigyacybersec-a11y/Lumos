import { App, TFile, arrayBufferToBase64 } from 'obsidian';
import { LLMTransport } from './llm/transport';
import { VisionCache } from './visionCache';

const VISION_PROMPT = 'Extract all text and describe any useful semantic information, diagrams, or whiteboard notes from this image. Output only the extracted information without conversational filler.';

export class VisionExtractor {
    transport: LLMTransport;
    app: App;
    cache: VisionCache | null;

    constructor(app: App, transport: LLMTransport, cache: VisionCache | null = null) {
        this.app = app;
        this.transport = transport;
        this.cache = cache;
    }

    async extractImageText(file: TFile): Promise<string> {
        if (this.cache) {
            const cached = this.cache.get(file, this.transport.visionModelName);
            if (cached) return cached;
        }
        const buffer = await this.app.vault.readBinary(file);
        const base64 = arrayBufferToBase64(buffer);
        const transcription = await this.transport.vision(VISION_PROMPT, base64, this.getMimeType(file.extension));
        this.cache?.set(file, this.transport.visionModelName, transcription);
        return transcription;
    }

    private getMimeType(extension: string): string {
        switch (extension.toLowerCase()) {
            case 'png': return 'image/png';
            case 'jpg':
            case 'jpeg': return 'image/jpeg';
            case 'webp': return 'image/webp';
            default: return 'image/jpeg';
        }
    }
}
