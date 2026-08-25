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

            const handleLine = (raw: string) => {
                const trimmed = raw.trim();
                if (!trimmed) return;
                try {
                    const parsed = JSON.parse(
                        !isOllama && trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed
                    );
                    if (!isOllama && trimmed === 'data: [DONE]') return;
                    const delta = isOllama
                        ? parsed.message?.content
                        : parsed.choices?.[0]?.delta?.content;
                    if (delta) { full += delta; onChunk(delta); }
                } catch { /* partial or non-JSON line */ }
            };

            while (!done) {
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) handleLine(line);
                const next = await reader.read();
                done = next.done;
                if (next.value) buffer += decoder.decode(next.value, { stream: true });
            }
            if (buffer) handleLine(buffer);
            return full;
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`${this.settings.provider} stream failed: ${e.message}`);
        }
    }

    async embed(text: string): Promise<number[]> {
        if (this.settings.provider === 'ollama') {
            const res = await withApiTimeout(requestUrl({
                url: joinUrl(this.settings.baseUrl, '/api/embeddings'),
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.settings.embeddingModelName || OLLAMA_EMBED_FALLBACK,
                    prompt: text,
                }),
            }), this.timeoutSec(), 'Embedding request');
            if (res.status !== 200) throw new Error('Ollama embedding failed');
            return res.json.embedding;
        }
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
        }), this.timeoutSec(), 'Embedding request');
        if (res.status !== 200) throw new Error('OpenRouter embedding failed');
        return res.json.data[0].embedding;
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
            if (res.status !== 200) throw new Error('Ollama vision failed: ' + res.text);
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
        if (res.status !== 200) throw new Error('OpenRouter vision failed: ' + res.text);
        return res.json.choices[0].message.content;
    }
}

export function createTransport(settings: ProviderSettings): LLMTransport {
    return new RestTransport(settings);
}
