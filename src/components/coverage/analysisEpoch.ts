import { useStore } from '../../store';

/**
 * Guard for the analysis panels' async runs (C5-09). Each run grabs a guard
 * before its first `await` and checks it before every store write, so a result
 * that arrives after the user pressed Clear, started a newer run, or switched
 * to another feed is dropped instead of repainting the map or the new feed's
 * session.
 *
 * Counters are per analysis kind so starting a Coverage run doesn't cancel an
 * Access Isochrone run. A feed change is detected from the editor's project id
 * AND the store's feed-load counter: an anonymous replace-import keeps the same
 * project id, so the id alone would let the old feed's result land on the new
 * one. The counter is bumped by every loadingFeed() path (store/index.ts),
 * which also clears the store-held results.
 */
export type AnalysisKind = 'coverage' | 'access' | 'walkshed' | 'titlevi';

const epochs: Record<AnalysisKind, number> = { coverage: 0, access: 0, walkshed: 0, titlevi: 0 };

/** Invalidate any in-flight run of this kind (Clear bumps it). */
export function bumpAnalysisEpoch(kind: AnalysisKind): void {
  epochs[kind]++;
}

/**
 * Start a run: invalidates earlier runs of the same kind and returns a
 * predicate that is true only while this run is still the current one for the
 * same feed.
 */
export function beginAnalysis(kind: AnalysisKind): () => boolean {
  const mine = ++epochs[kind];
  const feed = feedKey();
  return () => epochs[kind] === mine && feedKey() === feed;
}

/** Identity of the loaded feed: changes on a project switch and on every feed
 *  load or replace, including a same-project anonymous replace-import. */
export function feedKey(): string {
  const { projectId, feedLoadSeq } = useStore.getState();
  return `${projectId}#${feedLoadSeq}`;
}

/** The same feed identity as a React subscription, for panels that keep their
 *  result in local state and must clear it when the feed changes. */
export function useFeedKey(): string {
  return useStore((s) => `${s.projectId}#${s.feedLoadSeq}`);
}
