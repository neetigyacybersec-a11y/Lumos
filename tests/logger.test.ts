import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../src/logger';
import { createLogSink } from './mocks/logSink';

/**
 * Regression: Logger.init is the first call in plugin onload — a broken init
 * (e.g. the stray `this.plugin = plugin` leftover) takes down the whole
 * plugin with "Failed to load".
 */

describe('Logger', () => {
    afterEach(() => {
        // Reset static state between tests
        Logger.init(null as any);
        Logger.testState().logQueue.length = 0;
    });

    it('REGRESSION: init assigns the sink without throwing', () => {
        const sink = createLogSink();
        expect(() => Logger.init(sink)).not.toThrow();
        expect(Logger.testState().plugin).toBe(sink);
    });

    it('writeLog queues when a sink is present', async () => {
        Logger.init(createLogSink());
        const processSpy = vi.spyOn(Logger as any, 'processQueue').mockImplementation(() => {});
        Logger.info('hello world');
        expect(Logger.testState().logQueue.some((l: string) => l.includes('hello world'))).toBe(true);
        processSpy.mockRestore();
    });

    it('stays console-only without a sink', async () => {
        Logger.init(null as any);
        const processSpy = vi.spyOn(Logger as any, 'processQueue');
        await Logger.writeLog('INFO', 'no sink message');
        expect(processSpy).not.toHaveBeenCalled();
        expect(Logger.testState().logQueue).toHaveLength(0);
        processSpy.mockRestore();
    });

    it('writes queued lines to the log file through the adapter, capping at maxLogLines', async () => {
        const written: string[] = [];
        let current: string[] = ['existing line'];

        const sink = createLogSink({
            manifest: { dir: '/fake/dir' },
            app: {
                vault: {
                    adapter: {
                        exists: async () => true,
                        read: async () => current.join('\n'),
                        write: async (_path, data) => {
                            written.length = 0;
                            written.push(...data.split('\n').filter((l) => l.length > 0));
                        },
                    },
                },
            },
        });

        Logger.init(sink);
        Logger.maxLogLines = 3;
        Logger.info('line one');
        Logger.info('line two');
        await Logger.writeLog('INFO', 'line three');

        // processQueue is fire-and-forget; drain the microtask/retry chain before asserting.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(written).toHaveLength(3);
        expect(written.some((l) => l.includes('line one'))).toBe(true);
        expect(written.some((l) => l.includes('line two'))).toBe(true);
        expect(written.some((l) => l.includes('line three'))).toBe(true);
        expect(written.some((l) => l.includes('existing line'))).toBe(false);
    });
});
