import { describe, it, expect } from 'vitest';
import {
	DEFAULT_BASE_URL,
	isKnownDefaultBaseUrl,
	isOpenRouterUrl,
	normalizeBaseUrl,
	validateBaseUrl,
} from '../src/llm/providerConfig';

describe('normalizeBaseUrl', () => {
	it('trims whitespace and trailing slashes', () => {
		expect(normalizeBaseUrl('  https://openrouter.ai/api/v1///  ')).toBe('https://openrouter.ai/api/v1');
	});

	it('reduces a blank value to empty', () => {
		expect(normalizeBaseUrl('   ')).toBe('');
	});
});

describe('validateBaseUrl', () => {
	it('accepts any http(s) base URL, not just known vendors', () => {
		for (const url of [
			'http://localhost:11434',
			'https://openrouter.ai/api/v1',
			'https://api.tokenrouter.dev/v1',
			'http://192.168.1.20:1234/v1',
			'https://my-private-gateway.internal:8080/openai/v1',
		]) {
			expect(validateBaseUrl(url).ok, url).toBe(true);
		}
	});

	it('returns the normalized URL on success', () => {
		expect(validateBaseUrl('https://openrouter.ai/api/v1/')).toEqual({
			ok: true,
			url: 'https://openrouter.ai/api/v1',
		});
	});

	it('reports a missing URL', () => {
		expect(validateBaseUrl('')).toEqual({ ok: false, error: 'Base URL is required.' });
	});

	it('reports a missing scheme', () => {
		expect(validateBaseUrl('localhost:11434')).toEqual({
			ok: false,
			error: 'Base URL must start with http:// or https:// (got "localhost:11434").',
		});
	});

	it('reports spaces inside the URL', () => {
		expect(validateBaseUrl('https://api.example.com/v 1')).toEqual({
			ok: false,
			error: 'Base URL must not contain spaces.',
		});
	});

	it('rejects a non-http protocol', () => {
		expect(validateBaseUrl('ftp://api.example.com/v1')).toEqual({
			ok: false,
			error: 'Only http:// and https:// URLs are supported (got "ftp://").',
		});
	});

	it('reports a URL that already includes the endpoint path', () => {
		const result = validateBaseUrl('https://openrouter.ai/api/v1/chat/completions');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('remove the "/chat/completions" path');
		}
	});
});

describe('isOpenRouterUrl', () => {
	it('recognises openrouter.ai and its subdomains', () => {
		expect(isOpenRouterUrl('https://openrouter.ai/api/v1')).toBe(true);
		expect(isOpenRouterUrl('https://beta.openrouter.ai/api/v1')).toBe(true);
	});

	it('treats other OpenAI-compatible hosts as not OpenRouter', () => {
		expect(isOpenRouterUrl('https://api.tokenrouter.dev/v1')).toBe(false);
		expect(isOpenRouterUrl('not a url')).toBe(false);
	});
});

describe('isKnownDefaultBaseUrl', () => {
	it('matches only the shipped format defaults', () => {
		expect(isKnownDefaultBaseUrl(DEFAULT_BASE_URL.ollama)).toBe(true);
		expect(isKnownDefaultBaseUrl(DEFAULT_BASE_URL.openai)).toBe(true);
		expect(isKnownDefaultBaseUrl('https://api.tokenrouter.dev/v1')).toBe(false);
	});
});