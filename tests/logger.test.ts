import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../src/logger';

/**
 * Regression: Logger.init is the first call in plugin onload — a broken init
 * (e.g. the stray `this.plugin = plugin` leftover) takes down the whole
 * plugin with "Failed to load".
 */

const sink = {
    manifest: { dir: '/fake/dir' },
    app: { vault: { adapter: { exists: async () => false, read: async () => '', write: async () => {} } } },
};

describe('Logger', () => {
    afterEach(() => {
        // Reset static state between tests
        (Logger as any).plugin = null;
        (Logger as any).logQueue.length = 0;
    });

    it('REGRESSION: init assigns the sink without throwing and enables file logging', () => {
        expect(() => Logger.init(sink as any)).not.toThrow();
        expect((Logger as any).plugin).toBe(sink);
    });

    it('writeLog queues when a sink is present', async () => {
        Logger.init(sink as any);
        const processSpy = vi.spyOn(Logger as any, 'processQueue').mockImplementation(() => {});
        Logger.info('hello world');
        expect((Logger as any).logQueue.some((l: string) => l.includes('hello world'))).toBe(true);
        processSpy.mockRestore();
    });

    it('stays console-only without a sink', async () => {
        (Logger as any).plugin = null;
        const processSpy = vi.spyOn(Logger as any, 'processQueue');
        await Logger.writeLog('INFO', 'no sink message');
        expect(processSpy).not.toHaveBeenCalled();
        expect((Logger as any).logQueue).toHaveLength(0);
        processSpy.mockRestore();
    });
});
