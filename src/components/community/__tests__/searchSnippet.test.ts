import { describe, expect, it } from 'vitest';
import { parseSearchSnippet } from '../searchSnippet';

describe('parseSearchSnippet', () => {
  it('splits on <mark> and decodes escaped text', () => {
    expect(parseSearchSnippet('a &lt;img src=x&gt; <mark>validator</mark> &amp; &quot;b&#39;')).toEqual([
      { text: 'a <img src=x> ', mark: false },
      { text: 'validator', mark: true },
      { text: ' & "b\'', mark: false },
    ]);
  });

  it('keeps any other tag-like content as plain text', () => {
    const segs = parseSearchSnippet('<img src=x onerror=alert(1)><mark>hit</mark>');
    expect(segs[0]).toEqual({ text: '<img src=x onerror=alert(1)>', mark: false });
    expect(segs[1]).toEqual({ text: 'hit', mark: true });
  });

  it('returns no segments for an empty snippet', () => {
    expect(parseSearchSnippet('')).toEqual([]);
  });
});
