/**
 * Unit tests for src/services/forumReadState.ts
 *
 * localStorage is a browser API not available in Node. Each test uses
 * vi.stubGlobal to install an in-memory replacement following the same
 * pattern as threadPermalink.test.ts (which stubs window.location.origin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSeenMap,
  isThreadUnseen,
  isCategoryUnseen,
  markThreadSeen,
  markCategorySeen,
  type SeenMap,
} from '../../../services/forumReadState';

// ─── localStorage stub ───────────────────────────────────────────────────────

function makeLocalStorageStub(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  } as Storage;
}

// ─── isThreadUnseen ──────────────────────────────────────────────────────────

describe('isThreadUnseen', () => {
  it('returns true for a thread the user has never opened', () => {
    const seenMap: SeenMap = {};
    expect(isThreadUnseen('t-1', 1000, seenMap)).toBe(true);
  });

  it('returns false when the thread was seen after its last post', () => {
    // seen at 2000, lastPostAt 1000 — nothing new
    const seenMap: SeenMap = { 't-1': 2000 };
    expect(isThreadUnseen('t-1', 1000, seenMap)).toBe(false);
  });

  it('returns false when seen timestamp equals lastPostAt exactly', () => {
    const seenMap: SeenMap = { 't-1': 1000 };
    expect(isThreadUnseen('t-1', 1000, seenMap)).toBe(false);
  });

  it('returns true when the thread has activity newer than last seen', () => {
    // seen at 1000, new post at 2000
    const seenMap: SeenMap = { 't-1': 1000 };
    expect(isThreadUnseen('t-1', 2000, seenMap)).toBe(true);
  });

  it('treats other thread ids as independent', () => {
    const seenMap: SeenMap = { 't-2': 9999 };
    // t-1 is not in seenMap — unseen
    expect(isThreadUnseen('t-1', 1000, seenMap)).toBe(true);
    // t-2 IS in seenMap — seen (9999 > 1000)
    expect(isThreadUnseen('t-2', 1000, seenMap)).toBe(false);
  });
});

// ─── isCategoryUnseen ───────────────────────────────────────────────────────

describe('isCategoryUnseen', () => {
  it('returns false when latestActivityAt is null', () => {
    expect(isCategoryUnseen('cat-1', null, {})).toBe(false);
  });

  it('returns false when latestActivityAt is undefined', () => {
    expect(isCategoryUnseen('cat-1', undefined, {})).toBe(false);
  });

  it('returns true for a category the user has never browsed', () => {
    expect(isCategoryUnseen('cat-1', 1000, {})).toBe(true);
  });

  it('returns false when the category was visited after latest activity', () => {
    const seenMap: SeenMap = { 'cat:cat-1': 2000 };
    expect(isCategoryUnseen('cat-1', 1000, seenMap)).toBe(false);
  });

  it('returns false when visited time equals latestActivityAt exactly', () => {
    const seenMap: SeenMap = { 'cat:cat-1': 1000 };
    expect(isCategoryUnseen('cat-1', 1000, seenMap)).toBe(false);
  });

  it('returns true when category has activity newer than last visit', () => {
    const seenMap: SeenMap = { 'cat:cat-1': 1000 };
    expect(isCategoryUnseen('cat-1', 2000, seenMap)).toBe(true);
  });

  it('uses the namespaced cat: key — does not collide with thread ids', () => {
    // seenMap has a key "cat-1" (a thread id, not a category key)
    const seenMap: SeenMap = { 'cat-1': 9999 };
    // category key is "cat:cat-1" — absent, so unseen
    expect(isCategoryUnseen('cat-1', 1000, seenMap)).toBe(true);
  });
});

// ─── markThreadSeen / markCategorySeen / getSeenMap ─────────────────────────

describe('markThreadSeen', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorageStub());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists the thread id with a current timestamp', () => {
    const before = Date.now();
    markThreadSeen('t-abc');
    const after = Date.now();
    const map = getSeenMap();
    expect(map['t-abc']).toBeGreaterThanOrEqual(before);
    expect(map['t-abc']).toBeLessThanOrEqual(after);
  });

  it('does NOT write a cat: key when categoryId is omitted', () => {
    markThreadSeen('t-abc');
    const map = getSeenMap();
    const catKeys = Object.keys(map).filter((k) => k.startsWith('cat:'));
    expect(catKeys).toHaveLength(0);
  });

  it('also writes a cat: key when categoryId is provided', () => {
    markThreadSeen('t-abc', 'general');
    const map = getSeenMap();
    expect(map['t-abc']).toBeDefined();
    expect(map['cat:general']).toBeDefined();
  });

  it('marks the thread unseen after new activity arrives', () => {
    const seenAt = Date.now();
    markThreadSeen('t-abc');
    const map = getSeenMap();
    // thread has a new post 1 second AFTER we marked it seen
    expect(isThreadUnseen('t-abc', seenAt + 1000, map)).toBe(true);
    // thread has no new activity
    expect(isThreadUnseen('t-abc', seenAt - 1000, map)).toBe(false);
  });
});

describe('markCategorySeen', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorageStub());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists the cat: key with a current timestamp', () => {
    const before = Date.now();
    markCategorySeen('general');
    const after = Date.now();
    const map = getSeenMap();
    expect(map['cat:general']).toBeGreaterThanOrEqual(before);
    expect(map['cat:general']).toBeLessThanOrEqual(after);
  });

  it('clears the unseen dot for that category', () => {
    markCategorySeen('general');
    const map = getSeenMap();
    // latestActivityAt older than our visit — not unseen
    expect(isCategoryUnseen('general', Date.now() - 5000, map)).toBe(false);
  });
});
