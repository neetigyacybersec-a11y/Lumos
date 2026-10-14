/**
 * Provider configuration primitives: which wire protocol the plugin speaks, and
 * how a user-supplied base URL is validated and normalised.
 *
 * Deliberately dependency-free (no `obsidian`, no network) so the settings UI,
 * the transport and the tests all share one definition of "a valid base URL".
 */

/**
 * The wire protocol, not the vendor. Any OpenAI-compatible endpoint —
 * OpenRouter, TokenRouter, LM Studio, vLLM, Groq, together, … — uses `openai`.
 */
export type ApiFormat = 'ollama' | 'openai';

/** Sensible starting point per format, used as the field placeholder and when
 * switching format while a default URL is untouched. */
export const DEFAULT_BASE_URL: Record<ApiFormat, string> = {
	ollama: 'http://localhost:11434',
	openai: 'https://openrouter.ai/api/v1',
};

/**
 * Strips surrounding whitespace and trailing slashes so `joinUrl` can append a
 * path without doubling the separator. Returns the trimmed input unchanged when
 * it is not a usable URL, so the caller can still surface it.
 */
export function normalizeBaseUrl(raw: string): string {
	return (raw ?? '').trim().replace(/\/+$/, '');
}

export type UrlValidation =
	| { ok: true; url: string }
	| { ok: false; error: string };

/** Paths the plugin appends itself; a base URL ending in one would double up. */
const ENDPOINT_SUFFIXES = [
	'/chat/completions',
	'/completions',
	'/embeddings',
	'/models',
	'/api/chat',
	'/api/tags',
	'/api/embeddings',
	'/api/generate',
];

/**
 * Validates a user-supplied base URL. Accepts any http(s) host — the point of
 * allowing arbitrary base URLs — but rejects the mistakes that produce opaque
 * runtime failures: missing scheme, spaces, non-http protocols, and URLs that
 * already include the endpoint path the plugin appends.
 */
export function validateBaseUrl(raw: string): UrlValidation {
	const url = normalizeBaseUrl(raw);
	if (!url) return { ok: false, error: 'Base URL is required.' };
	if (/\s/.test(url)) return { ok: false, error: 'Base URL must not contain spaces.' };
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
		return { ok: false, error: `Base URL must start with http:// or https:// (got "${url}").` };
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: `"${url}" is not a valid URL.` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, error: `Only http:// and https:// URLs are supported (got "${parsed.protocol}//").` };
	}
	if (!parsed.hostname) return { ok: false, error: 'Base URL is missing a host name.' };

	const path = parsed.pathname.replace(/\/+$/, '');
	const suffix = ENDPOINT_SUFFIXES.find(s => path.endsWith(s));
	if (suffix) {
		return {
			ok: false,
			error: `Use the base URL only — remove the "${suffix}" path, the plugin appends it automatically.`,
		};
	}
	return { ok: true, url };
}

/** True when the host is OpenRouter, which accepts optional attribution headers. */
export function isOpenRouterUrl(raw: string): boolean {
	try {
		const host = new URL(normalizeBaseUrl(raw)).hostname.toLowerCase();
		return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
	} catch {
		return false;
	}
}

/** True when the URL is untouched from one of the format defaults, so it is
 * safe to swap on a format change without clobbering a custom endpoint. */
export function isKnownDefaultBaseUrl(raw: string): boolean {
	const url = normalizeBaseUrl(raw);
	return url === DEFAULT_BASE_URL.ollama || url === DEFAULT_BASE_URL.openai;
}
