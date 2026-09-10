import { describe, it, expect } from 'vitest';
import { BeautifyCache } from '../src/beautifyCache';

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

describe('BeautifyCache', () => {
    it('stores and returns a whole-note record', () => {
        const cache = new BeautifyCache(makePlugin());
        cache.setWhole('note.md', { sourceHash: 'abc', wholeBeautified: 'beautified', model: 'm1', optsHash: 'o1' });
        const record = cache.getNote('note.md');
        expect(record?.wholeBeautified).toBe('beautified');
        expect(record?.sourceHash).toBe('abc');
        expect(record?.blocks).toEqual([]);
    });

    it('setWhole preserves existing blocks', () => {
        const cache = new BeautifyCache(makePlugin());
        cache.setBlock('note.md', { key: 'k1', source: 'src', beautified: 'blk', model: 'm1', cachedAt: 1 });
        cache.setWhole('note.md', { sourceHash: 'abc', wholeBeautified: 'whole', model: 'm1', optsHash: 'o1' });
        expect(cache.getBlock('note.md', 'k1')?.beautified).toBe('blk');
    });

    it('stores and returns blocks keyed by hash', () => {
        const cache = new BeautifyCache(makePlugin());
        cache.setBlock('note.md', { key: 'k1', source: 'a', beautified: 'A', model: 'm1', cachedAt: 1 });
        cache.setBlock('note.md', { key: 'k2', source: 'b', beautified: 'B', model: 'm1', cachedAt: 2 });
        expect(cache.getBlock('note.md', 'k1')?.beautified).toBe('A');
        expect(cache.getBlock('note.md', 'k2')?.beautified).toBe('B');
        expect(cache.getNote('note.md')?.blocks).toHaveLength(2);
    });

    it('invalidateNote drops the whole record', () => {
        const cache = new BeautifyCache(makePlugin());
        cache.setWhole('note.md', { sourceHash: 'abc', wholeBeautified: 'whole', model: 'm1', optsHash: 'o1' });
        expect(cache.getNote('note.md')).not.toBeNull();
        cache.invalidateNote('note.md', true);
        expect(cache.getNote('note.md')).toBeNull();
    });

    it('persists records across instances', async () => {
        const adapter = makeAdapter();
        const first = new BeautifyCache(makePlugin(adapter));
        await first.load();
        first.setWhole('note.md', { sourceHash: 'abc', wholeBeautified: 'whole', model: 'm1', optsHash: 'o1' });
        await first.forceSave();

        const second = new BeautifyCache(makePlugin(adapter));
        await second.load();
        expect(second.getNote('note.md')?.wholeBeautified).toBe('whole');
    });

    it('clear drops everything', async () => {
        const cache = new BeautifyCache(makePlugin());
        cache.setWhole('note.md', { sourceHash: 'abc', wholeBeautified: 'whole', model: 'm1', optsHash: 'o1' });
        await cache.clear(true);
        expect(cache.getNote('note.md')).toBeNull();
    });

    it('evicts old blocks past the per-note cap', async () => {
        const cache = new BeautifyCache(makePlugin());
        for (let i = 0; i < 205; i++) {
            cache.setBlock('note.md', { key: `k${i}`, source: `${i}`, beautified: `${i}`, model: 'm1', cachedAt: i });
        }
        expect(cache.getBlock('note.md', 'k0')).toBeNull();
        expect(cache.getBlock('note.md', 'k204')?.beautified).toBe('204');
        expect(cache.getNote('note.md')?.blocks.length).toBe(200);
        await cache.forceSave();
    });
});