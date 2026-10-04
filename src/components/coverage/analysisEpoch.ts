import { useStore } from '../../store';

/**
 * Guard for the analysis panels' async runs (C5-09). Each run grabs a guard
 * before its first `await` and checks it before every store write, so a result
 * that arrives after the user pressed Clear, started a newer run, or switched
 * to another feed is dropped instead of repainting the map or the new feed's
 * session.
 *
 * Counters are per analysis kind so starting a Coverage run doesn't cancel an
 * Access Isochrone run. A feed switch is detected from the editor's project id.
 */
export type AnalysisKind = 'coverage' | 'access' | 'walkshed';

const epochs: Record<AnalysisKind, number> = { coverage: 0, access: 0, walkshed: 0 };

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
  const projectId = useStore.getState().projectId;
  return () => epochs[kind] === mine && useStore.getState().projectId === projectId;
}
