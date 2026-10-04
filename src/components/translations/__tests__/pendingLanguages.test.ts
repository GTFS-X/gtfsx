// C3-14: clearing the only translation for a language must not unmount its card.
import { describe, expect, it } from 'vitest';
import { pendingAfterEdit } from '../pendingLanguages';

describe('pendingAfterEdit', () => {
  it('pins the language when its input is cleared', () => {
    expect(pendingAfterEdit([], 'es', '')).toEqual(['es']);
  });

  it('leaves pending alone while typing, and never duplicates', () => {
    const p = ['fr'];
    expect(pendingAfterEdit(p, 'es', 'Hola')).toBe(p);
    expect(pendingAfterEdit(['es'], 'es', '')).toEqual(['es']);
  });
});
