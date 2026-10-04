import { describe, expect, it } from 'vitest';
import { insertSnippets } from '../composerInsert';
import { replyCountLabel } from '../replyCount';

describe('insertSnippets', () => {
  it('inserts several image links at once, each on its own line', () => {
    const { next, caret } = insertSnippets('hello', 5, 5, ['![a](/_forum-images/a.png)', '![b](/_forum-images/b.png)']);
    expect(next).toBe('hello\n![a](/_forum-images/a.png)\n![b](/_forum-images/b.png)\n');
    expect(caret).toBe(next.length);
  });

  it('replaces the selection and keeps the text after it', () => {
    const { next, caret } = insertSnippets('one TWO three', 4, 7, ['X']);
    expect(next).toBe('one \nX\n three');
    expect(next.slice(0, caret)).toBe('one \nX\n');
  });

  it('adds no leading newline at the start or after a newline', () => {
    expect(insertSnippets('', 0, 0, ['X']).next).toBe('X\n');
    expect(insertSnippets('a\n', 2, 2, ['X']).next).toBe('a\nX\n');
  });
});

describe('replyCountLabel', () => {
  it('does not count the opening post as a reply', () => {
    expect(replyCountLabel(1)).toBe('0 replies');
    expect(replyCountLabel(2)).toBe('1 reply');
    expect(replyCountLabel(5)).toBe('4 replies');
    expect(replyCountLabel(0)).toBe('0 replies');
  });
});
