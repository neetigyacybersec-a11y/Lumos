import { PluginSettings } from './types';
import { requestUrl, App, TFile, arrayBufferToBase64 } from 'obsidian';

export class VisionExtractor {
    settings: PluginSettings;
    app: App;

    constructor(app: App, settings: PluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    async extractImageText(file: TFile): Promise<string> {
        // Read file as binary
        const buffer = await this.app.vault.readBinary(file);
        // Convert to base64
        const base64 = arrayBufferToBase64(buffer);
        const mimeType = this.getMimeType(file.extension);

        const prompt = "Extract all text and describe any useful semantic information, diagrams, or whiteboard notes from this image. Output only the extracted information without conversational filler.";

        if (this.settings.provider === 'openrouter') {
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: this.settings.visionModelName || 'openai/gpt-4o-mini',
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                            ]
                        }
                    ]
                })
            });

            if (res.status !== 200) throw new Error('OpenRouter vision failed: ' + res.text);
            return res.json.choices[0].message.content;
        } else {
            // Ollama vision (e.g. llava)
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/api/generate';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.settings.visionModelName || 'llava',
                    prompt: prompt,
                    images: [base64],
                    stream: false
                })
            });
            if (res.status !== 200) throw new Error('Ollama vision failed: ' + res.text);
            return res.json.response;
        }
    }

    private getMimeType(extension: string): string {
        switch(extension.toLowerCase()) {
            case 'png': return 'image/png';
            case 'jpg':
            case 'jpeg': return 'image/jpeg';
            case 'webp': return 'image/webp';
            default: return 'image/jpeg';
        }
    }
}
