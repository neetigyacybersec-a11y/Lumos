import { Logger } from './logger';

export interface IndexManifest {
    schemaVersion: number;
    embeddingModel: string;
    pluginVersion: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * The persisted index schema version. Bump ONLY when the vector/chunk shape
 * changes in a way that makes old vectors unreadable; a bump is a signal that
 * the index must be rebuilt. This must NOT change just because plugin code
 * changed — a plain version update must reuse the existing index.
 */
export const SCHEMA_VERSION = 2;

const MANIFEST_FILE = 'lumos-index.json';

export function readManifest(plugin: { manifest?: { dir?: string } }, adapter: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
}): Promise<IndexManifest | null> {
    const dir = plugin.manifest?.dir || '';
    if (!dir) return Promise.resolve(null);
    const path = `${dir}/${MANIFEST_FILE}`;
    return adapter.exists(path)
        .then((exists) => (exists ? adapter.read(path) : null))
        .then((data) => (data ? JSON.parse(data) as IndexManifest : null))
        .catch((e) => {
            Logger.warn('[Lumos] Failed to read index manifest:', e);
            return null;
        });
}

export async function writeManifest(plugin: { manifest?: { dir?: string; version?: string } }, adapter: {
    exists(path: string): Promise<boolean>;
    write(path: string, data: string): Promise<void>;
}, embeddingModel: string): Promise<void> {
    const dir = plugin.manifest?.dir || '';
    if (!dir) return;
    const path = `${dir}/${MANIFEST_FILE}`;
    const now = Date.now();
    const previous = await readManifest(plugin, adapter);
    const manifest: IndexManifest = {
        schemaVersion: SCHEMA_VERSION,
        embeddingModel,
        pluginVersion: plugin.manifest?.version || '',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
    };
    try {
        await adapter.write(path, JSON.stringify(manifest, null, 2));
    } catch (e) {
        Logger.warn('[Lumos] Failed to write index manifest:', e);
    }
}

/**
 * True when a rebuild is genuinely required because the persisted index was
 * produced by an incompatible embedding model or schema. Consumption does NOT
 * auto-rebuild on this; it only informs the user a manual rebuild is available.
 * A plain plugin-version bump with the same model/schema returns false.
 */
export function manifestNeedsRebuild(manifest: IndexManifest | null, currentEmbeddingModel: string): boolean {
    if (!manifest) return false;
    if (manifest.schemaVersion !== SCHEMA_VERSION) return true;
    if (manifest.embeddingModel && manifest.embeddingModel !== currentEmbeddingModel) return true;
    return false;
}
