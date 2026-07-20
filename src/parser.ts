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
}
