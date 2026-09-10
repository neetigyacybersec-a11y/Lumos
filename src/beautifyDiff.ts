export interface Block {
    text: string;
    start: number;
}

const FENCE_RE = /^\s*(```|~~~)/;

export function splitBlocks(content: string): Block[] {
    const lines = content.split('\n');
    const offsets: number[] = [0];
    for (let k = 0; k < lines.length; k++) offsets[k + 1] = offsets[k] + lines[k].length + 1;

    const blocks: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        if (i === 0 && lines[0].trim() === '---') {
            let j = 1;
            while (j < lines.length && lines[j].trim() !== '---') j++;
            const end = Math.min(j + 1, lines.length);
            blocks.push({ start: 0, text: lines.slice(0, end).join('\n') });
            i = end;
            continue;
        }

const buf: string[] = [];
        const start = offsets[i];
        let inCode = false;
        while (i < lines.length) {
            const line = lines[i];
            if (FENCE_RE.test(line)) inCode = !inCode;
            if (inCode) {
                buf.push(line);
                i++;
                continue;
            }
            if (line.trim() === '') break;
            buf.push(line);
            i++;
        }
        while (i < lines.length && lines[i].trim() === '') i++;

        const text = buf.join('\n');
        if (text.trim() !== '') blocks.push({ start, text });
    }
    return blocks;
}

export function blockAt(content: string, offset: number): Block | null {
    const blocks = splitBlocks(content);
    if (blocks.length === 0) return null;
    for (let idx = 0; idx < blocks.length; idx++) {
        const block = blocks[idx];
        const end = block.start + block.text.length;
        if (offset >= block.start && offset < end) return block;
    }
    return blocks[blocks.length - 1];
}