import { requestUrl } from 'obsidian';

/**
 * The single LLM provider seam. Every Ollama-vs-OpenRouter protocol detail —
 * URL shapes, auth headers, payload field names, response unwrapping, model
 * fallbacks, timeouts and the error taxonomy — lives here, once.
 *
 * Two adapters exist today (Ollama local, OpenRouter cloud), which is what
 * makes this a real seam rather than a hypothetical one.
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
    return baseUrl.replace(/\/$/, '') + path;
}

export interface ProviderSettings {
    provider: 'ollama' | 'openrouter';
    baseUrl: string;
    apiKey?: string;
    llmModelName: string;
    embeddingModelName: string;
    visionModelName: string;
    requestTimeoutSec: number;
}

const OLLAMA_CHAT_FALLBACK = 'llama3';
const OPENROUTER_CHAT_FALLBACK = 'meta-llama/llama-3-8b-instruct';
const OLLAMA_EMBED_FALLBACK = 'nomic-embed-text';
const OPENROUTER_EMBED_FALLBACK = 'openai/text-embedding-3-small';
const OLLAMA_VISION_FALLBACK = 'llava';
const OPENROUTER_VISION_FALLBACK = 'openai/gpt-4o-mini';

export interface ChatOptions {
    expectJson?: boolean;
}

export type StreamProvider = 'ollama' | 'openrouter';

/**
 * Decodes one SSE/NDJSON line into its text delta.
 *
 * `ollama` lines are plain JSON lumps (`{"message":{"content":"..."}}`);
 * `openrouter` lines are `data: {json}` with a `data: [DONE]` terminator.
 * Returns an empty string for lines that carry no text (keep-alives,
 * partial/non-JSON noise, or the [DONE] marker).
 */
export function parseSSELine(raw: string, provider: StreamProvider): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (provider !== 'ollama' && trimmed === 'data: [DONE]') return '';
    try {
        const parsed = JSON.parse(
            provider !== 'ollama' && trimmed.startsWith('data: ')
                ? trimmed.slice(6)
                : trimmed
        );
        const delta = provider === 'ollama'
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
    provider: StreamProvider,
    onDelta: (delta: string) => void
): { leftover: string; done: boolean } {
    const lines = buffer.split('\n');
    const leftover = lines.pop() ?? '';
    for (const line of lines) {
        const delta = parseSSELine(line, provider);
        if (delta) onDelta(delta);
    }
    return { leftover, done: leftover.length === 0 };
}

export interface LLMTransport {
    readonly provider: 'ollama' | 'openrouter';
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

    get provider(): 'ollama' | 'openrouter' {
        return this.settings.provider;
    }

    private timeoutSec(): number {
        return this.settings.requestTimeoutSec || 60;
    }

    private openrouterHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.settings.apiKey}`,
            // OpenRouter attribution headers; harmless elsewhere but only sent here.
            'HTTP-Referer': 'https://github.com/obsidianmd/obsidian-api',
            'X-Title': 'Obsidian Relation Plugin',
        };
    }

    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
        if (this.settings.provider === 'ollama') {
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
            model: this.settings.llmModelName || OPENROUTER_CHAT_FALLBACK,
            messages,
        };
        if (opts.expectJson) body.response_format = { type: 'json_object' };
        try {
            const res = await withApiTimeout(requestUrl({
                url: joinUrl(this.settings.baseUrl, '/chat/completions'),
                method: 'POST',
                headers: this.openrouterHeaders(),
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
        const isOllama = this.settings.provider === 'ollama';
        const url = isOllama
            ? joinUrl(this.settings.baseUrl, '/api/chat')
            : joinUrl(this.settings.baseUrl, '/chat/completions');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!isOllama) Object.assign(headers, this.openrouterHeaders());
        const body = JSON.stringify({
            model: this.settings.llmModelName || (isOllama ? OLLAMA_CHAT_FALLBACK : OPENROUTER_CHAT_FALLBACK),
            messages,
            stream: true,
        });

        try {
            const res = await fetch(url, { method: 'POST', headers, body });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                throw new TransientApiError(`${this.settings.provider} stream failed (${res.status}): ${text}`);
            }
            const reader = res.body.getReader();
            // Cap time-to-first-chunk only; long generations stream freely.
            const first = await withApiTimeout(reader.read(), this.timeoutSec(), `${this.settings.provider} stream first chunk`);
            const decoder = new TextDecoder();
            let buffer = decoder.decode(first.value ?? { stream: true }, { stream: true });
            let done = first.done;
            let full = '';

            const emit = (delta: string) => { full += delta; onChunk(delta); };

            while (!done) {
                const { leftover } = drainBuffer(buffer, isOllama ? 'ollama' : 'openrouter', emit);
                buffer = leftover;
                const next = await reader.read();
                done = next.done;
                if (next.value) buffer += decoder.decode(next.value, { stream: true });
            }
            if (buffer) drainBuffer(buffer, isOllama ? 'ollama' : 'openrouter', emit);
            return full;
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`${this.settings.provider} stream failed: ${e.message}`);
        }
    }

    async embed(text: string): Promise<number[]> {
        if (this.settings.provider === 'ollama') {
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
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.settings.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.settings.embeddingModelName || OPENROUTER_EMBED_FALLBACK,
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
        if (this.settings.provider === 'ollama') {
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
            headers: this.openrouterHeaders(),
            body: JSON.stringify({
                model: this.settings.visionModelName || OPENROUTER_VISION_FALLBACK,
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
