import { describe, it, expect } from 'vitest';
import { RelationExtractor } from '../src/relations';

describe('Relation Extractor', () => {
	it('constructs a prompt that contains source and candidate data', () => {
		const extractor = new RelationExtractor({
			provider: 'ollama',
			baseUrl: 'http://localhost:11434',
			modelName: 'llama3'
		});

		const prompt = extractor.constructPrompt('source.md', 'Source content', [
			{ path: 'target.md', text: 'Target content' }
		]);

		expect(prompt).toContain('Source Note File: source.md');
		expect(prompt).toContain('Target content');
	});
});
