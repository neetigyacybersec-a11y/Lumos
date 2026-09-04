import { LogSink } from '../../src/ports';

export function createLogSink(overrides: Partial<LogSink> = {}): LogSink {
    let loggedLines: string[] = [];

    const adapter = {
        exists: async (_path: string) => false,
        read: async (_path: string) => '',
        write: async (_path: string, data: string) => {
            loggedLines = data.split('\n').filter((l) => l.length > 0);
        },
    };

    const sink: LogSink = {
        manifest: { dir: '/fake/dir' },
        app: { vault: { adapter } },
    };

    return { ...sink, ...overrides };
}
