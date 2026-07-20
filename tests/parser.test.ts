import { describe, it, expect } from 'vitest';
import { Parser } from '../src/parser';
import { TFile } from 'obsidian';

describe('Parser', () => {
	it('strips frontmatter and extracts wikilinks and tags', async () => {
		const markdown = `---
title: Test Note
tags: [tag1, tag2]
---
# Header
This is a [[test link]] with some **bold** text and #tag3.
`;
		
		const mockApp: any = {
			vault: {
				read: async () => markdown
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						position: {
							start: { offset: 0 },
							end: { offset: 42 } // rough offset of ---
						},
						tags: ['tag1', 'tag2']
					},
					links: [
						{ link: 'test link' }
					],
					tags: [
						{ tag: '#tag3' }
					]
				})
			}
		};

		const parser = new Parser(mockApp);
		const file = {} as TFile;
		const parsed = await parser.parse(file);

		expect(parsed.cleanText).not.toContain('title: Test Note');
		expect(parsed.cleanText).toContain('Header');
		expect(parsed.cleanText).toContain('This is a test link with some bold text and tag3.');
		expect(parsed.wikilinks).toContain('test link');
		expect(parsed.tags).toContain('#tag1');
		expect(parsed.tags).toContain('#tag2');
		expect(parsed.tags).toContain('#tag3');
	});
});
