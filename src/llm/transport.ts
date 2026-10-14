import { requestUrl } from 'obsidian';
import { ApiFormat, normalizeBaseUrl, validateBaseUrl, isOpenRouterUrl } from './providerConfig';

/**
 * The single LLM provider seam. Every protocol detail — URL shapes, auth
 * headers, payload field names, response unwrapping, model fallbacks, timeouts
 * and the error taxonomy — lives here, once.
 *
 * Two formats exist (Ollama native, OpenAI-compatible), which is what makes
 * this a real seam rather than a hypothetical one. The format describes the
 * *protocol*; the base URL may point at any host (OpenRouter, TokenRouter,
 * LM Studio, vLLM, Groq, …) as long as it speaks that protocol.
 */

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class TerminalApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TerminalApiError';
    }
}

export class TransientApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TransientApiError';
    }
}

/**
 * Remote calls must never hang the caller: requestUrl/fetch have no default
 * timeout. Races the promise against a timer and surfaces timeouts as
 * TransientApiError so retry/circuit-break logic engages uniformly.
 */
export function withApiTimeout<T>(promise: Promise<T>, timeoutSec: number, label: string): Promise<T> {
    const seconds = Math.max(1, Math.floor(timeoutSec || 60));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new TransientApiError(`${label} timed out after ${seconds}s`)),
            seconds * 1000
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function joinUrl(baseUrl: string, path: string): string {
    return normalizeBaseUrl(baseUrl) + path;
}

export interface ProviderSettings {
    apiFormat: ApiFormat;
    baseUrl: string;
    apiKey?: string;
    llmModelName: string;
    embeddingModelName: string;
    visionModelName: string;
    requestTimeoutSec: number;
}

const OLLAMA_CHAT_FALLBACK = 'llama3';
const OPENAI_CHAT_FALLBACK = 'meta-llama/llama-3-8b-instruct';
const OLLAMA_EMBED_FALLBACK = 'nomic-embed-text';
const OPENAI_EMBED_FALLBACK = 'openai/text-embedding-3-small';
const OLLAMA_VISION_FALLBACK = 'llava';
const OPENAI_VISION_FALLBACK = 'openai/gpt-4o-mini';

/**
 * Headers for an OpenAI-compatible request. Auth is only sent when a key is
 * configured (many local gateways need none), and the OpenRouter attribution
 * headers are only attached when the host actually is OpenRouter.
 */
export function providerAuthHeaders(settings: { apiKey?: string; baseUrl: string }): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    if (isOpenRouterUrl(settings.baseUrl)) {
        headers['HTTP-Referer'] = 'https://github.com/obsidianmd/obsidian-api';
        headers['X-Title'] = 'Obsidian Relation Plugin';
    }
    return headers;
}

export interface ChatOptions {
    expectJson?: boolean;
}

/**
 * Decodes one SSE/NDJSON line into its text delta.
 *
 * `ollama` lines are plain JSON lumps (`{"message":{"content":"..."}}`);
 * `openai` lines are `data: {json}` with a `data: [DONE]` terminator.
 * Returns an empty string for lines that carry no text (keep-alives,
 * partial/non-JSON noise, or the [DONE] marker).
 */
export function parseSSELine(raw: string, format: ApiFormat): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (format !== 'ollama' && trimmed === 'data: [DONE]') return '';
    try {
        const parsed = JSON.parse(
            format !== 'ollama' && trimmed.startsWith('data: ')
                ? trimmed.slice(6)
                : trimmed
        );
        const delta = format === 'ollama'
            ? parsed.message?.content
            : parsed.choices?.[0]?.delta?.content;
        return typeof delta === 'string' ? delta : '';
    } catch {
        return '';
    }
}

/**
 * Splits buffered stream text into complete lines, forwarding each complete
 * line's decoded delta through `onDelta`. Returns the leftover partial line to
 * carry into the next read, flagged `done` when the tail was flushed.
 */
export function drainBuffer(
    buffer: string,
    format: ApiFormat,
    onDelta: (delta: string) => void
): { leftover: string; done: boolean } {
    const lines = buffer.split('\n');
    const leftover = lines.pop() ?? '';
    for (const line of lines) {
        const delta = parseSSELine(line, format);
        if (delta) onDelta(delta);
    }
    return { leftover, done: leftover.length === 0 };
}

export interface LLMTransport {
    readonly format: ApiFormat;
    readonly llmModelName: string;
    readonly visionModelName: string;
    chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
    /**
     * Streaming variant. onChunk receives deltas as they arrive; the returned
     * promise resolves with the full text. The requestTimeoutSec setting caps
     * time-to-first-chunk only — long generations are not cut off mid-stream.
     */
    chatStream(messages: ChatMessage[], onChunk: (chunk: string) => void): Promise<string>;
    embed(text: string): Promise<number[]>;
    vision(prompt: string, imageBase64: string, mimeType: string): Promise<string>;
}

class RestTransport implements LLMTransport {
    constructor(private settings: ProviderSettings) {}

    get format(): ApiFormat {
        return this.settings.apiFormat;
    }

    get llmModelName(): string {
        return this.settings.llmModelName;
    }

    get visionModelName(): string {
        return this.settings.visionModelName;
    }

    private timeoutSec(): number {
        return this.settings.requestTimeoutSec || 60;
    }

    private authHeaders(): Record<string, string> {
        return providerAuthHeaders(this.settings);
    }

    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
        if (this.settings.apiFormat === 'ollama') {
            const body: any = {
                model: this.settings.llmModelName || OLLAMA_CHAT_FALLBACK,
                messages,
                stream: false,
            };
            if (opts.expectJson) body.format = 'json';
            try {
                const res = await withApiTimeout(requestUrl({
                    url: joinUrl(this.settings.baseUrl, '/api/chat'),
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    throw: false,
                }), this.timeoutSec(), 'Ollama request');
                if (res.status !== 200) {
                    if (res.status === 404 || res.status === 400) throw new TerminalApiError(`Ollama Error (${res.status}): Model not found or bad request.`);
                    throw new TransientApiError(`Ollama Network Error (${res.status})`);
                }
                return res.json.message.content;
            } catch (e) {
                if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
                throw new TransientApiError(`Ollama Connection Failed: ${e.message}`);
            }
        }

        const body: any = {
            model: this.settings.llmModelName || OPENAI_CHAT_FALLBACK,
            messages,
        };
        if (opts.expectJson) body.response_format = { type: 'json_object' };
        try {
            const res = await withApiTimeout(requestUrl({
                url: joinUrl(this.settings.baseUrl, '/chat/completions'),
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(body),
                throw: false,
            }), this.timeoutSec(), 'LLM request');
            if (res.status !== 200) {
                if ([401, 402, 403, 404, 400].includes(res.status)) {
                    throw new TerminalApiError(`API Error (${res.status}): ${res.text}`);
                }
                throw new TransientApiError(`API Transient Error (${res.status}): ${res.text}`);
            }
            return res.json.choices[0].message.content;
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`API Connection Failed: ${e.message}`);
        }
    }

    async chatStream(messages: ChatMessage[], onChunk: (chunk: string) => void): Promise<string> {
        const isOllama = this.settings.apiFormat === 'ollama';
        const url = isOllama
            ? joinUrl(this.settings.baseUrl, '/api/chat')
            : joinUrl(this.settings.baseUrl, '/chat/completions');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!isOllama) Object.assign(headers, this.authHeaders());
        const body = JSON.stringify({
            model: this.settings.llmModelName || (isOllama ? OLLAMA_CHAT_FALLBACK : OPENAI_CHAT_FALLBACK),
            messages,
            stream: true,
        });

        try {
            const res = await fetch(url, { method: 'POST', headers, body });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                throw new TransientApiError(`${this.settings.apiFormat} stream failed (${res.status}): ${text}`);
            }
            const reader = res.body.getReader();
            // Cap time-to-first-chunk only; long generations stream freely.
            const first = await withApiTimeout(reader.read(), this.timeoutSec(), `${this.settings.apiFormat} stream first chunk`);
            const decoder = new TextDecoder();
            let buffer = decoder.decode(first.value ?? { stream: true }, { stream: true });
            let done = first.done;
            let full = '';

            const emit = (delta: string) => { full += delta; onChunk(delta); };

            while (!done) {
                const { leftover } = drainBuffer(buffer, isOllama ? 'ollama' : 'openai', emit);
                buffer = leftover;
                const next = await reader.read();
                done = next.done;
                if (next.value) buffer += decoder.decode(next.value, { stream: true });
            }
            if (buffer) drainBuffer(buffer, isOllama ? 'ollama' : 'openai', emit);
            return full;
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`${this.settings.apiFormat} stream failed: ${e.message}`);
        }
    }

    async embed(text: string): Promise<number[]> {
        if (this.settings.apiFormat === 'ollama') {
            try {
                const res = await withApiTimeout(requestUrl({
                    url: joinUrl(this.settings.baseUrl, '/api/embeddings'),
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.settings.embeddingModelName || OLLAMA_EMBED_FALLBACK,
                        prompt: text,
                    }),
                    throw: false,
                }), this.timeoutSec(), 'Embedding request');
                if (res.status !== 200) {
                    if (res.status === 404 || res.status === 400) throw new TerminalApiError(`Ollama embedding failed (${res.status}): model not found or bad request`);
                    throw new TransientApiError(`Ollama embedding failed (${res.status})`);
                }
                return res.json.embedding;
            } catch (e) {
                if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
                throw new TransientApiError(`Ollama embedding failed: ${e.message}`);
            }
        }

        try {
            const res = await withApiTimeout(requestUrl({
                url: joinUrl(this.settings.baseUrl, '/embeddings'),
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    model: this.settings.embeddingModelName || OPENAI_EMBED_FALLBACK,
                    input: text,
                }),
                throw: false,
            }), this.timeoutSec(), 'Embedding request');
            if (res.status !== 200) {
                if ([401, 402, 403, 404, 400].includes(res.status)) throw new TerminalApiError(`Embedding API Error (${res.status}): ${res.text}`);
                throw new TransientApiError(`Embedding API Transient Error (${res.status}): ${res.text}`);
            }
            return res.json.data[0].embedding;
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`Embedding API Connection Failed: ${e.message}`);
        }
    }

    async vision(prompt: string, imageBase64: string, mimeType: string): Promise<string> {
        if (this.settings.apiFormat === 'ollama') {
            const res = await withApiTimeout(requestUrl({
                url: joinUrl(this.settings.baseUrl, '/api/generate'),
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.settings.visionModelName || OLLAMA_VISION_FALLBACK,
                    prompt,
                    images: [imageBase64],
                    stream: false,
                }),
                throw: false,
            }), this.timeoutSec(), 'Ollama vision request');
            if (res.status !== 200) {
                if (res.status === 404 || res.status === 400) throw new TerminalApiError(`Ollama vision failed (${res.status}): model not found or bad request`);
                throw new TransientApiError(`Ollama vision failed (${res.status}): ${res.text}`);
            }
            return res.json.response;
        }
        const res = await withApiTimeout(requestUrl({
            url: joinUrl(this.settings.baseUrl, '/chat/completions'),
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({
                model: this.settings.visionModelName || OPENAI_VISION_FALLBACK,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
                    ],
                }],
            }),
            throw: false,
        }), this.timeoutSec(), 'Vision request');
        if (res.status !== 200) {
            if ([401, 402, 403, 404, 400].includes(res.status)) throw new TerminalApiError(`Vision API Error (${res.status}): ${res.text}`);
            throw new TransientApiError(`Vision API Transient Error (${res.status}): ${res.text}`);
        }
        return res.json.choices[0].message.content;
    }
}

export function createTransport(settings: ProviderSettings): LLMTransport {
    return new RestTransport(settings);
}

/** Minimal shape of Obsidian's `requestUrl`, injectable for tests. */
export type RequestUrlFn = (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    throw?: boolean;
}) => Promise<{ status: number; text?: string; json?: any }>;

export interface ConnectionResult {
    ok: boolean;
    message: string;
    /** Model ids reported by the endpoint, when it lists them. */
    models?: string[];
}

export type ConnectionSettings = Pick<ProviderSettings, 'apiFormat' | 'baseUrl' | 'apiKey' | 'requestTimeoutSec'>;

function extractModelIds(format: ApiFormat, json: any): string[] {
    if (format === 'ollama') {
        return Array.isArray(json?.models) ? json.models.map((m: any) => m?.name).filter(Boolean) : [];
    }
    return Array.isArray(json?.data) ? json.data.map((m: any) => m?.id).filter(Boolean) : [];
}

function describeHttpFailure(status: number, body: string): string {
    const detail = body ? ` — ${body}` : '';
    if (status === 401 || status === 403) return `Authentication failed (HTTP ${status}). Check your API key.`;
    if (status === 404) return `Endpoint not found (HTTP 404). Check the base URL — OpenAI-compatible APIs usually end in /v1. Some gateways don't expose /models even when chat works.`;
    if (status === 429) return `Rate limited (HTTP 429). Try again shortly.`;
    return `Server returned HTTP ${status}${detail}`;
}

/**
 * Probes the configured endpoint with a cheap GET (Ollama `/api/tags`,
 * OpenAI-compatible `/models`) and turns the outcome into a message a user can
 * act on — the "report the error" half of base-URL validation. Never throws:
 * a malformed URL, an unreachable host and an HTTP failure all come back as a
 * structured result so the settings UI can render it inline.
 */
export async function testProviderConnection(
    settings: ConnectionSettings,
    requestFn: RequestUrlFn = requestUrl as unknown as RequestUrlFn
): Promise<ConnectionResult> {
    const validation = validateBaseUrl(settings.baseUrl);
    if (!validation.ok) return { ok: false, message: validation.error };

    const isOllama = settings.apiFormat === 'ollama';
    const url = joinUrl(validation.url, isOllama ? '/api/tags' : '/models');

    try {
        const res = await withApiTimeout(requestFn({
            url,
            method: 'GET',
            headers: isOllama ? { 'Content-Type': 'application/json' } : providerAuthHeaders(settings),
            throw: false,
        }), settings.requestTimeoutSec || 60, 'Connection test');

        if (res.status !== 200) {
            return { ok: false, message: describeHttpFailure(res.status, (res.text ?? '').slice(0, 200)) };
        }

        const models = extractModelIds(settings.apiFormat, res.json);
        const message = models.length
            ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`
            : 'Connected, but the endpoint listed no models — check your model names.';
        return { ok: true, message, models };
    } catch (e) {
        return { ok: false, message: `Could not reach ${url}: ${e?.message ?? e}` };
    }
}
