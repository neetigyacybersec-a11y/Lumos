import { describe, it, expect } from 'vitest';
import { parseSSELine, drainBuffer } from '../src/llm/transport';

describe('parseSSELine', () => {
	it('decodes an openrouter data: JSON delta', () => {
		const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
		expect(parseSSELine(line, 'openrouter')).toBe('Hello');
	});

	it('ignores the openrouter [DONE] marker', () => {
		expect(parseSSELine('data: [DONE]', 'openrouter')).toBe('');
	});

	it('decodes an ollama JSON lump', () => {
		const line = '{"message":{"content":"world"}}';
		expect(parseSSELine(line, 'ollama')).toBe('world');
	});

	it('returns empty for keep-alive / non-JSON noise and blank lines', () => {
		expect(parseSSELine('', 'openrouter')).toBe('');
		expect(parseSSELine(': ping', 'openrouter')).toBe('');
		expect(parseSSELine('not json', 'ollama')).toBe('');
		expect(parseSSELine('   ', 'openrouter')).toBe('');
	});

	it('returns empty when the delta carries no text', () => {
		expect(parseSSELine('data: {"choices":[{"delta":{"role":"assistant"}}]}', 'openrouter')).toBe('');
		expect(parseSSELine('{"done":true}', 'ollama')).toBe('');
	});
});

describe('drainBuffer', () => {
	it('forwards each complete line delta and keeps the partial tail as leftover', () => {
		const deltas: string[] = [];
		const { leftover, done } = drainBuffer(
			'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: {"choices":[{"delta":{"conte',
			'openrouter',
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
			'openrouter',
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
			'openrouter',
			(d) => deltas.push(d)
		);
		expect(deltas).toEqual([]);
		expect(leftover).toBe('data: {"choices":[{"delta":{"content":"x"}}]}');
		expect(done).toBe(false);
	});

	it('skips marker lines without emitting', () => {
		const deltas: string[] = [];
		drainBuffer('data: [DONE]\ndata: {"choices":[{"delta":{"content":"z"}}]}\n', 'openrouter', (d) => deltas.push(d));
		expect(deltas).toEqual(['z']);
	});
});
