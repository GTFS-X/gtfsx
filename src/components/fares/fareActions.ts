// Multi-write GTFS-Fares v1 editor actions, each one undo step (C3-17).
import { useStore } from '../../store';
import { historyTransaction } from '../../store/history';
import {
  applyTypePrefix,
  ensureUniqueFareId,
  routeRuleIndices,
  type FareType,
} from './fareEditorHelpers';

/**
 * Switch a fare's type chip: rename the fare_id prefix (the store cascades the
 * rename to fare_rules and flex zones, C3-06) and zero the price for "Free".
 * Returns the fare's id afterwards.
 */
export function applyFareType(fareId: string, type: FareType): string {
  const st = useStore.getState();
  const fare = st.fareAttributes.find((f) => f.fare_id === fareId);
  if (!fare) return fareId;
  const desired = applyTypePrefix(fareId, type);
  const newId = ensureUniqueFareId(desired, st.fareAttributes.map((f) => f.fare_id), fareId);
  historyTransaction('change fare type', () => {
    if (newId !== fareId) useStore.getState().renameFareId(fareId, newId);
    if (type === 'Free' && fare.price !== '0.00') {
      useStore.getState().updateFareAttribute(newId, { price: '0.00' });
    }
  });
  return newId;
}

/** "All routes": drop the fare's route rules (zone-pair rules stay, C3-05),
 *  highest index first so the remaining indices stay valid. */
export function setFareAllRoutes(fareId: string): void {
  const indices = routeRuleIndices(useStore.getState().fareRules, fareId);
  if (indices.length === 0) return;
  historyTransaction('fare applies to all routes', () => {
    for (const idx of [...indices].reverse()) useStore.getState().removeFareRuleAt(idx);
  });
}
