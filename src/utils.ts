// Simple hash function for strings
export function hashString(str: string): string {
    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36); // Short base36 string
}

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
