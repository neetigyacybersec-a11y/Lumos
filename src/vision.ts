import { PluginSettings } from './types';
import { App, TFile, arrayBufferToBase64 } from 'obsidian';
import { createTransport } from './llm/transport';

const VISION_PROMPT = 'Extract all text and describe any useful semantic information, diagrams, or whiteboard notes from this image. Output only the extracted information without conversational filler.';

export class VisionExtractor {
    settings: PluginSettings;
    app: App;

    constructor(app: App, settings: PluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    async extractImageText(file: TFile): Promise<string> {
        const buffer = await this.app.vault.readBinary(file);
        const base64 = arrayBufferToBase64(buffer);
        return createTransport(this.settings).vision(VISION_PROMPT, base64, this.getMimeType(file.extension));
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
