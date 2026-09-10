import { describe, it, expect } from 'vitest';
import { splitBlocks, blockAt } from '../src/beautifyDiff';

describe('splitBlocks', () => {
    it('splits paragraphs on blank lines and reports character offsets', () => {
        const content = 'alpha\n\nbeta\n\n\ngamma';
        const blocks = splitBlocks(content);
        expect(blocks.map(b => b.text)).toEqual(['alpha', 'beta', 'gamma']);
        expect(blocks[0].start).toBe(0);
        expect(blocks[1].start).toBe(7);
        expect(blocks[2].start).toBe(14);
    });

    it('keeps frontmatter as its own leading block', () => {
        const content = '---\ntags: x\n---\n\nBody';
        const blocks = splitBlocks(content);
        expect(blocks[0].text).toBe('---\ntags: x\n---');
        expect(blocks[1].text).toBe('Body');
    });

    it('does not split fenced code blocks on internal blank lines', () => {
        const content = 'intro\n\n```\nline 1\n\nline 3\n```\n\noutro';
        const blocks = splitBlocks(content);
        expect(blocks.map(b => b.text)).toEqual(['intro', '```\nline 1\n\nline 3\n```', 'outro']);
    });

    it('handles a single line and empty content', () => {
        expect(splitBlocks('only one').map(b => b.text)).toEqual(['only one']);
        expect(splitBlocks('')).toEqual([]);
        expect(splitBlocks('\n\n\n')).toEqual([]);
    });

    it('treats list items as one block when contiguous', () => {
        const content = '* a\n* b\n\npara';
        const blocks = splitBlocks(content);
        expect(blocks[0].text).toBe('* a\n* b');
    });
});

describe('blockAt', () => {
    it('finds the block containing the cursor offset', () => {
        const content = 'one\n\ntwo';
        const blocks = splitBlocks(content);
        expect(blockAt(content, 0)?.text).toBe('one');
        expect(blockAt(content, blocks[1].start + 1)?.text).toBe('two');
    });

    it('maps a gap (blank line) offset to the following block', () => {
        const content = 'one\n\ntwo';
        expect(blockAt(content, 4)?.text).toBe('two');
    });

    it('maps an out-of-range offset to the last block', () => {
        const content = 'one\n\ntwo';
        expect(blockAt(content, 999)?.text).toBe('two');
    });

    it('returns null for empty content', () => {
        expect(blockAt('', 0)).toBeNull();
    });
});