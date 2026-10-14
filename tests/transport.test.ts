import { describe, it, expect } from 'vitest';
import { parseSSELine, drainBuffer } from '../src/llm/transport';

describe('parseSSELine', () => {
	it('decodes an OpenAI-compatible data: JSON delta', () => {
		const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
		expect(parseSSELine(line, 'openai')).toBe('Hello');
	});

	it('ignores the OpenAI-compatible [DONE] marker', () => {
		expect(parseSSELine('data: [DONE]', 'openai')).toBe('');
	});

	it('decodes an ollama JSON lump', () => {
		const line = '{"message":{"content":"world"}}';
		expect(parseSSELine(line, 'ollama')).toBe('world');
	});

	it('returns empty for keep-alive / non-JSON noise and blank lines', () => {
		expect(parseSSELine('', 'openai')).toBe('');
		expect(parseSSELine(': ping', 'openai')).toBe('');
		expect(parseSSELine('not json', 'ollama')).toBe('');
		expect(parseSSELine('   ', 'openai')).toBe('');
	});

	it('returns empty when the delta carries no text', () => {
		expect(parseSSELine('data: {"choices":[{"delta":{"role":"assistant"}}]}', 'openai')).toBe('');
		expect(parseSSELine('{"done":true}', 'ollama')).toBe('');
	});
});

describe('drainBuffer', () => {
	it('forwards each complete line delta and keeps the partial tail as leftover', () => {
		const deltas: string[] = [];
		const { leftover, done } = drainBuffer(
			'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: {"choices":[{"delta":{"conte',
			'openai',
			(d) => deltas.push(d)
		);
		expect(deltas).toEqual(['a', 'b']);
		expect(leftover).toBe('data: {"choices":[{"delta":{"conte');
		expect(done).toBe(false);
	});

	it('reports done when the buffer is fully consumed', () => {
		const deltas: string[] = [];
		const { leftover, done } = drainBuffer(
			'data: {"choices":[{"delta":{"content":"x"}}]}\n',
			'openai',
			(d) => deltas.push(d)
		);
		expect(deltas).toEqual(['x']);
		expect(leftover).toBe('');
		expect(done).toBe(true);
	});

	it('treats a final unterminated line as partial leftover (carried to next read)', () => {
		const deltas: string[] = [];
		const { leftover, done } = drainBuffer(
			'data: {"choices":[{"delta":{"content":"x"}}]}',
			'openai',
			(d) => deltas.push(d)
		);
		expect(deltas).toEqual([]);
		expect(leftover).toBe('data: {"choices":[{"delta":{"content":"x"}}]}');
		expect(done).toBe(false);
	});

	it('skips marker lines without emitting', () => {
		const deltas: string[] = [];
		drainBuffer('data: [DONE]\ndata: {"choices":[{"delta":{"content":"z"}}]}\n', 'openai', (d) => deltas.push(d));
		expect(deltas).toEqual(['z']);
	});
});
