import { createWorker } from 'tesseract.js';
import { TFile, App, arrayBufferToBase64 } from 'obsidian';

export class LocalOcr {
    app: App;
    
    constructor(app: App) {
        this.app = app;
    }

    async hasText(file: TFile): Promise<boolean> {
        try {
            const buffer = await this.app.vault.readBinary(file);
            const worker = await createWorker('eng');
            
            const base64 = arrayBufferToBase64(buffer);
            let mimeType = 'image/jpeg';
            if (file.extension.toLowerCase() === 'png') mimeType = 'image/png';
            if (file.extension.toLowerCase() === 'webp') mimeType = 'image/webp';
            const dataUri = `data:${mimeType};base64,${base64}`;

            const ret = await worker.recognize(dataUri);
            await worker.terminate();

            const text = ret.data.text;
            // Remove whitespace and check if there are at least 10 characters
            const clean = text.replace(/\s+/g, '').trim();
            
            if (clean.length < 10) {
                return false;
            }
            
            return true;
        } catch (e) {
            // If Tesseract fails for any reason (e.g., CDN blocked), fallback to true so we don't drop the image
            return true; 
        }
    }
}
