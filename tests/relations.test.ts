import { describe, it, expect } from 'vitest';
import { RelationExtractor } from '../src/relations';
import { PluginSettings } from '../src/types';

describe('Relation Extractor', () => {
	it('constructs a prompt that contains source and candidate data', () => {
		const mockPlugin = {
			settings: {
				provider: 'ollama',
				baseUrl: 'http://localhost:11434',
				modelName: 'llama3'
			}
		} as any;
		const extractor = new RelationExtractor(mockPlugin);

		const prompt = extractor.constructPrompt('source.md', 'Source content', [
			{ path: 'target.md', text: 'Target content' }
		]);

		expect(prompt).toContain('Source Note File: source.md');
		expect(prompt).toContain('Target content');
	});
});
