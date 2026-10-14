import { describe, it, expect, vi } from 'vitest';
import { providerAuthHeaders, testProviderConnection } from '../src/llm/transport';

const openaiSettings = {
	apiFormat: 'openai' as const,
	baseUrl: 'https://api.tokenrouter.dev/v1',
	apiKey: 'test-key',
	requestTimeoutSec: 5,
};

describe('testProviderConnection', () => {
	it('reports success and the model count for an OpenAI-compatible endpoint', async () => {
		const requestFn = vi.fn().mockResolvedValue({
			status: 200,
			json: { data: [{ id: 'model-a' }, { id: 'model-b' }] },
		});

		const result = await testProviderConnection(openaiSettings, requestFn);

		expect(result.ok).toBe(true);
		expect(result.models).toEqual(['model-a', 'model-b']);
		expect(requestFn.mock.calls[0][0].url).toBe('https://api.tokenrouter.dev/v1/models');
	});

	it('probes /api/tags on the ollama format and reads its model shape', async () => {
		const requestFn = vi.fn().mockResolvedValue({
			status: 200,
			json: { models: [{ name: 'llama3' }] },
		});

		const result = await testProviderConnection(
			{ ...openaiSettings, apiFormat: 'ollama', baseUrl: 'http://localhost:11434' },
			requestFn
		);

		expect(requestFn.mock.calls[0][0].url).toBe('http://localhost:11434/api/tags');
		expect(result.models).toEqual(['llama3']);
		expect(result.ok).toBe(true);
	});

	it('refuses a malformed base URL without making a request', async () => {
		const requestFn = vi.fn();

		const result = await testProviderConnection({ ...openaiSettings, baseUrl: 'localhost:11434' }, requestFn);

		expect(result.ok).toBe(false);
		expect(result.message).toContain('http://');
		expect(requestFn).not.toHaveBeenCalled();
	});

	it('reports an auth failure as an actionable message', async () => {
		const requestFn = vi.fn().mockResolvedValue({ status: 401, text: 'invalid key' });

		const result = await testProviderConnection(openaiSettings, requestFn);

		expect(result.ok).toBe(false);
		expect(result.message).toContain('Check your API key');
	});

	it('reports a 404 with a hint about the /v1 path', async () => {
		const requestFn = vi.fn().mockResolvedValue({ status: 404, text: '' });

		const result = await testProviderConnection(openaiSettings, requestFn);

		expect(result.ok).toBe(false);
		expect(result.message).toContain('/v1');
	});

	it('reports an unreachable host rather than throwing', async () => {
		const requestFn = vi.fn().mockRejectedValue(new Error('ERR_CONNECTION_REFUSED'));

		const result = await testProviderConnection(openaiSettings, requestFn);

		expect(result.ok).toBe(false);
		expect(result.message).toContain('Could not reach');
		expect(result.message).toContain('ERR_CONNECTION_REFUSED');
	});

	it('reports success but flags an endpoint that lists no models', async () => {
		const requestFn = vi.fn().mockResolvedValue({ status: 200, json: {} });

		const result = await testProviderConnection(openaiSettings, requestFn);

		expect(result.ok).toBe(true);
		expect(result.models).toEqual([]);
		expect(result.message).toContain('no models');
	});
});

describe('providerAuthHeaders', () => {
	it('sends bearer auth only when a key is configured', () => {
		expect(providerAuthHeaders({ apiKey: 'k', baseUrl: 'https://api.tokenrouter.dev/v1' }).Authorization)
			.toBe('Bearer k');
		expect(providerAuthHeaders({ apiKey: '', baseUrl: 'http://localhost:1234/v1' }).Authorization)
			.toBeUndefined();
	});

	it('adds attribution headers only for openrouter.ai', () => {
		expect(providerAuthHeaders({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' })['HTTP-Referer'])
			.toBeTruthy();
		expect(providerAuthHeaders({ apiKey: 'k', baseUrl: 'https://api.tokenrouter.dev/v1' })['HTTP-Referer'])
			.toBeUndefined();
	});
});