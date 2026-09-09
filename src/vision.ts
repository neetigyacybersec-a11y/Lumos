import { App, TFile, arrayBufferToBase64 } from 'obsidian';
import { LLMTransport } from './llm/transport';

const VISION_PROMPT = 'Extract all text and describe any useful semantic information, diagrams, or whiteboard notes from this image. Output only the extracted information without conversational filler.';

export class VisionExtractor {
    transport: LLMTransport;
    app: App;

    constructor(app: App, transport: LLMTransport) {
        this.app = app;
        this.transport = transport;
    }

    async extractImageText(file: TFile): Promise<string> {
        const buffer = await this.app.vault.readBinary(file);
        const base64 = arrayBufferToBase64(buffer);
        return this.transport.vision(VISION_PROMPT, base64, this.getMimeType(file.extension));
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
