import { describe, it, expect } from 'vitest';
import { VisionCache } from '../src/visionCache';

function makeAdapter(initial: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initial };
    return {
        async read(p: string): Promise<string> {
            if (!(p in files)) throw new Error('ENOENT');
            return files[p];
        },
        async write(p: string, d: string): Promise<void> {
            files[p] = d;
        },
        async exists(p: string): Promise<boolean> {
            return p in files;
        },
        async remove(p: string): Promise<void> {
            delete files[p];
        },
        async rename(o: string, n: string): Promise<void> {
            files[n] = files[o];
            delete files[o];
        },
    };
}

function makePlugin(adapter: any = makeAdapter()) {
    return { app: { vault: { adapter } }, manifest: { dir: 'plugins/test' } };
}

const IMG = { path: 'assets/photo.png', stat: { mtime: 1000, size: 4200 } };

describe('VisionCache', () => {
    it('round-trips a caption for a matching file and model', async () => {
        const cache = new VisionCache(makePlugin());
        await cache.load();
        cache.set(IMG, 'vision-v2', 'the extracted text');
        expect(cache.get(IMG, 'vision-v2')).toBe('the extracted text');
        expect(cache.get(IMG, 'vision-v3')).toBeNull();
    });

    it('misses when the file changed (mtime or size)', () => {
        const cache = new VisionCache(makePlugin());
        cache.set(IMG, 'vision-v2', 'text');
        expect(cache.get({ ...IMG, stat: { mtime: 999, size: 4200 } }, 'vision-v2')).toBeNull();
        expect(cache.get({ ...IMG, stat: { mtime: 1000, size: 1 } }, 'vision-v2')).toBeNull();
    });

    it('misses when the file has no stat', () => {
        const cache = new VisionCache(makePlugin());
        cache.set(IMG, 'vision-v2', 'text');
        expect(cache.get({ path: IMG.path, stat: null }, 'vision-v2')).toBeNull();
    });

    it('persists entries across instances', async () => {
        const adapter = makeAdapter();
        const first = new VisionCache(makePlugin(adapter));
        await first.load();
        first.set(IMG, 'vision-v2', 'persisted text');
        await first.forceSave();

        const second = new VisionCache(makePlugin(adapter));
        await second.load();
        expect(second.get(IMG, 'vision-v2')).toBe('persisted text');
    });

    it('survives corrupted cache files', async () => {
        const cache = new VisionCache(makePlugin(makeAdapter({ 'plugins/test/vision-cache.json': '{broken' })));
        await cache.load();
        expect(cache.get(IMG, 'vision-v2')).toBeNull();
        cache.set(IMG, 'vision-v2', 'ok');
        expect(cache.get(IMG, 'vision-v2')).toBe('ok');
    });

    it('clear removes every entry', async () => {
        const cache = new VisionCache(makePlugin());
        await cache.load();
        cache.set(IMG, 'vision-v2', 'text');
        await cache.clear(true);
        expect(cache.get(IMG, 'vision-v2')).toBeNull();
    });
});