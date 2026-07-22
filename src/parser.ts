import { Logger } from './logger';
import { TFile, App } from 'obsidian';
import { ParsedNote } from './types';

export class Parser {
	app: App;
	
	constructor(app: App) {
		this.app = app;
	}

	async parse(file: TFile): Promise<ParsedNote> {
		const content = await this.app.vault.read(file);
		const cache = this.app.metadataCache.getFileCache(file);
		
		let cleanText = content;
		
		// Remove frontmatter
		if (cache?.frontmatter) {
			const { position } = cache.frontmatter;
			cleanText = content.substring(0, position.start.offset) + content.substring(position.end.offset);
		}

		// Extract wikilinks using obsidian's metadata cache
		const wikilinks: string[] = [];
		if (cache?.links) {
			for (const link of cache.links) {
				wikilinks.push(link.link);
			}
		}

		// Extract tags using obsidian's metadata cache
		const tags: string[] = [];
		if (cache?.tags) {
			for (const tag of cache.tags) {
				tags.push(tag.tag);
			}
		} 
        
        if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				tags.push(...fmTags.map(t => typeof t === 'string' && t.startsWith('#') ? t : `#${t}`));
			} else if (typeof fmTags === 'string') {
				tags.push(...fmTags.split(',').map(t => {
					const trimmed = t.trim();
					return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
				}));
			}
		}

		// Very basic markdown stripping (remove bold, italic, headers, simple links)
		cleanText = cleanText
			.replace(/!\[.*?\]\(.*?\)/g, '') // images
			.replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
			.replace(/\[\[(.*?)\]\]/g, '$1') // wikilinks
			.replace(/[#*_-]/g, ' ') // formatting chars
			.replace(/\s+/g, ' ') // collapse whitespace
			.trim();

		return {
			cleanText,
			wikilinks: [...new Set(wikilinks)],
			tags: [...new Set(tags)]
		};
	}

	async parsePdf(file: TFile): Promise<string> {
		const buffer = await this.app.vault.readBinary(file);
		try {
			// Try to use pdf-parse first, which is reliable in Node/Electron environments
			// Note: We need to use dynamic import or require to avoid esbuild issues if pdf-parse has node dependencies
			const pdfParse = require('pdf-parse');
			const data = await pdfParse(Buffer.from(buffer));
			return data.text;
		} catch (e) {
			Logger.warn("[Lumos] pdf-parse failed, falling back to window.pdfjsLib if available", e);
			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) throw new Error("pdfjsLib not found on window, and pdf-parse failed.");
			
			const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
			let text = '';
			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i);
				const content = await page.getTextContent();
				text += content.items.map((item: any) => item.str).join(' ') + '\n';
			}
			return text;
		}
	}
}
