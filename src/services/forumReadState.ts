/**
 * Client-side forum read/seen state, stored in localStorage.
 *
 * Key schema (all values are ms-epoch timestamps):
 *   "<threadId>"        — when the user last opened that thread
 *   "cat:<categoryId>"  — when the user last browsed that category's thread list
 *                         OR opened a thread in it (whichever was more recent)
 *
 * No server round-trips; works for both anonymous and signed-in users.
 * Cross-device sync is intentionally out of scope.
 */

const STORAGE_KEY = 'gtfsx_forum_seen';

/** Map of threadId / "cat:<categoryId>" to ms-epoch seen timestamp. */
export type SeenMap = Record<string, number>;

// ─── Storage helpers ────────────────────────────────────────────────────────

export function getSeenMap(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SeenMap;
    }
    return {};
  } catch {
    // JSON parse failure or localStorage unavailable (private browsing, etc.)
    return {};
  }
}

function writeSeenMap(map: SeenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage quota exceeded or unavailable — silently ignore.
  }
}

// ─── Write operations ───────────────────────────────────────────────────────

/**
 * Record that the user has opened a thread.
 * Optionally also advances the "category visited" timestamp so the home-page
 * category dot clears after reading the latest thread.
 */
export function markThreadSeen(threadId: string, categoryId?: string): void {
  const map = getSeenMap();
  const now = Date.now();
  map[threadId] = now;
  if (categoryId) {
    const catKey = `cat:${categoryId}`;
    if ((map[catKey] ?? 0) < now) map[catKey] = now;
  }
  writeSeenMap(map);
}

/**
 * Record that the user browsed a category's thread list.
 * Clears the home-page green dot for that category.
 */
export function markCategorySeen(categoryId: string): void {
  const map = getSeenMap();
  map[`cat:${categoryId}`] = Date.now();
  writeSeenMap(map);
}

// ─── Read predicates ────────────────────────────────────────────────────────

/**
 * Returns true when the thread has activity (lastPostAt) newer than the last
 * time the user opened it, or if the user has never opened it.
 */
export function isThreadUnseen(
  threadId: string,
  lastPostAt: number,
  seenMap: SeenMap,
): boolean {
  const seen = seenMap[threadId];
  if (seen === undefined) return true;
  return lastPostAt > seen;
}

/**
 * Returns true when the category has activity (latestActivityAt) newer than
 * the last time the user browsed its thread list or read a thread in it.
 */
export function isCategoryUnseen(
  categoryId: string,
  latestActivityAt: number | null | undefined,
  seenMap: SeenMap,
): boolean {
  if (!latestActivityAt) return false;
  const seen = seenMap[`cat:${categoryId}`];
  if (seen === undefined) return true;
  return latestActivityAt > seen;
}
