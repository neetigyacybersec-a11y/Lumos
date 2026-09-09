/**
 * Collision-resistant SHA-256 hash for string identity. Used both as the
 * whole-file content hash (skip unchanged files) and the per-chunk hash that
 * keys embedding reuse. A 32-bit polynomial hash (the old implementation) can
 * collide at vault scale, silently reusing the wrong embedding or treating an
 * edited file as unchanged — so identity must be cryptographic.
 */
export async function hashString(str: string): Promise<string> {
    const data = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** File types Lumos will parse, embed and relate. Single source of truth. */
export const INDEXABLE_EXTENSIONS = ['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

export function isPathIgnored(path: string, ignoredFoldersStr: string): boolean {
    if (!ignoredFoldersStr || ignoredFoldersStr.trim() === '') return false;
    
    const ignoredFolders = ignoredFoldersStr
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0);
        
    for (const folder of ignoredFolders) {
        if (path.includes(folder)) {
            return true;
        }
    }
    return false;
}
