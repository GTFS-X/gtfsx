import type { StateCreator } from 'zustand';
import { current, isDraft, type Draft } from 'immer';
import type { Stop, StopTime, RouteStop, Transfer, Translation, Pathway, StopArea } from '../types/gtfs';
import type { FlexZone } from './flexSlice';
import { translationsForRecords, withoutTranslationsFor } from '../services/translations';
import type { TripSlice } from './tripSlice';
import type { RouteSlice } from './routeSlice';
import { generateId } from '../services/idGenerator';

/** One stop's prior wheelchair_boarding, captured by a bulk fill so it can be
 *  undone. */
export interface WheelchairFill {
  stop_id: string;
  prev: number;
}

/**
 * Snapshot returned by removeStopWithSnapshot so the deletion can be undone.
 * Captures the stop row itself plus every cascaded row that removeStop drops
 * (stop_times, route_stops, transfers).
 */
export interface StopRemovalSnapshot {
  stop: Stop | undefined;
  stopTimes: StopTime[];
  routeStops: RouteStop[];
  transfers: Transfer[];
  /** translations.txt rows naming the stop (optional: older snapshots). */
  translations?: Translation[];
  /** pathways.txt rows with the stop at either end. */
  pathways?: Pathway[];
  /** stop_areas.txt rows assigning the stop to a fare area. */
  stopAreas?: StopArea[];
  /** Stops whose parent_station was this stop (cleared by the delete). */
  childStopIds?: string[];
  /** Flex zones whose stop group listed this stop, with its position there. */
  flexMemberships?: { zoneId: string; index: number }[];
}

/** The cross-slice tables a stop delete cascades into. */
type StopCascadeState = {
  stops: Stop[];
  stopTimes?: StopTime[];
  routeStops?: RouteStop[];
  transfers?: Transfer[];
  pathways?: Pathway[];
  stopAreas?: StopArea[];
  flexZones?: FlexZone[];
  translations?: Translation[];
};

/** A plain (non-proxy) view of a draft value, for fast bulk reads. Returns the
 *  base object itself when the draft is unmodified. */
function plain<T>(v: T): T {
  return isDraft(v) ? (current(v as Draft<T>) as T) : v;
}

/** `list` without the rows matching `drop`, or `list` itself (same reference)
 *  when nothing matched, so an untouched table doesn't register as changed. */
function without<T>(list: T[] | undefined, drop: (row: T) => boolean): T[] | undefined {
  if (!list) return list;
  const src = plain(list);
  const next = src.filter((row) => !drop(row));
  return next.length === src.length ? list : next;
}

/**
 * Remove every reference to the stops in `ids` from the rest of the feed:
 * stop_times, route_stops, transfers, pathways and stop_areas rows that name
 * them are dropped; surviving stops whose parent_station was one of them get
 * it cleared; flex zones' stop groups lose them; their translations go.
 *
 * Operates on an Immer draft (or any mutable state). Does NOT remove the stops
 * themselves; callers do that first. Shared by removeStop, removeStops,
 * removeStopWithSnapshot and removeRoute's orphaned-stop path so the cascade
 * can't drift between them.
 */
export function cascadeStopRemoval(state: object, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  const st = state as StopCascadeState;
  const hit = (id: string | undefined) => id !== undefined && ids.has(id);
  const assign = <K extends keyof StopCascadeState>(key: K, next: StopCascadeState[K]) => {
    if (next !== st[key]) st[key] = next;
  };
  assign('stopTimes', without(st.stopTimes, (r) => hit(r.stop_id)));
  assign('routeStops', without(st.routeStops, (r) => hit(r.stop_id)));
  assign('transfers', without(st.transfers, (r) => hit(r.from_stop_id) || hit(r.to_stop_id)));
  assign('pathways', without(st.pathways, (r) => hit(r.from_stop_id) || hit(r.to_stop_id)));
  assign('stopAreas', without(st.stopAreas, (r) => hit(r.stop_id)));
  // Children of a deleted station (platforms, entrances, nodes) survive as
  // stops, but must not keep pointing at a parent that no longer exists.
  // Rows are replaced (not mutated) because the caller may already have
  // swapped in a plain array of frozen store objects.
  plain(st.stops).forEach((s, i) => {
    if (hit(s.parent_station)) st.stops[i] = { ...s, parent_station: undefined };
  });
  if (st.flexZones) {
    plain(st.flexZones).forEach((z, i) => {
      if (z.stopIds?.some((id) => ids.has(id))) {
        st.flexZones![i] = { ...z, stopIds: z.stopIds.filter((id) => !ids.has(id)) };
      }
    });
  }
  const translations = withoutTranslationsFor(st.translations, 'stops', ids);
  if (translations !== st.translations) st.translations = translations;
}

export interface StopSlice {
  stops: Stop[];
  addStop: (stop: Stop) => void;
  updateStop: (stop_id: string, updates: Partial<Stop>) => void;
  removeStop: (stop_id: string) => void;
  /** Delete many stops (and everything that references them) in ONE store
   *  update, so it is one undo step and one pass over stop_times however many
   *  stops are removed. */
  removeStops: (stop_ids: string[]) => void;
  /** Clone a stop as a new standalone stop (no route/time associations),
   * nudged slightly so it doesn't sit exactly under the original. Returns the
   * new stop_id, or null if the source doesn't exist. */
  duplicateStop: (stop_id: string) => string | null;
  /** Bulk-fill wheelchair_boarding = `value` on the given stops, but ONLY where
   *  the stop has no accessible/not-accessible value yet — anything other than
   *  1 or 2 (0 / undefined = "no information" = a gap per the GTFS spec) is
   *  treated as missing. Never overwrites a stop that already has 1 or 2.
   *  Returns the prior values of the stops it changed, so the caller can offer
   *  an undo. */
  fillMissingWheelchairBoarding: (stopIds: string[], value: number) => WheelchairFill[];
  /** Revert a fillMissingWheelchairBoarding using its returned snapshot
   *  (unconditional set — restores exactly what those stops had before). */
  restoreWheelchairBoarding: (entries: WheelchairFill[]) => void;
  /** Delete a stop and cascade into stop_times, route_stops, and transfers,
   *  capturing a snapshot of every removed row so the deletion can be undone.
   *  Returns the snapshot; call restoreStop(snapshot) to reverse it. */
  removeStopWithSnapshot: (stop_id: string) => StopRemovalSnapshot;
  /** Revert a removeStopWithSnapshot: restores the stop and all cascaded rows
   *  that were removed. No-op if snapshot.stop is undefined (stop wasn't found). */
  restoreStop: (snapshot: StopRemovalSnapshot) => void;
  setStops: (stops: Stop[]) => void;
}

// removeStop cascades into other slices (stop_times, route_stops, transfers,
// pathways, stop_areas, flex zones, translations); widen the state view to cover those fields without resorting to `any`.
type CrossSliceState = StopSlice & TripSlice & RouteSlice & {
  transfers?: Transfer[];
  translations?: Translation[];
  pathways?: Pathway[];
  stopAreas?: StopArea[];
  flexZones?: FlexZone[];
};

export const createStopSlice: StateCreator<StopSlice, [['zustand/immer', never]], [], StopSlice> = (set, get) => ({
  stops: [],
  addStop: (stop) => set((state) => { state.stops.push(stop); }),
  updateStop: (stop_id, updates) => set((state) => {
    const idx = state.stops.findIndex((s) => s.stop_id === stop_id);
    if (idx !== -1) Object.assign(state.stops[idx], updates);
  }),
  removeStop: (stop_id) => set((state) => {
    state.stops = get().stops.filter((s) => s.stop_id !== stop_id);
    cascadeStopRemoval(state, new Set([stop_id]));
  }),
  removeStops: (stop_ids) => set((state) => {
    const ids = new Set(stop_ids);
    if (ids.size === 0) return;
    const before = get().stops;
    const next = before.filter((s) => !ids.has(s.stop_id));
    if (next.length === before.length) return;
    state.stops = next;
    cascadeStopRemoval(state, ids);
  }),
  duplicateStop: (stop_id) => {
    const orig = get().stops.find((s) => s.stop_id === stop_id);
    if (!orig) return null;
    const newId = generateId('stop');
    set((state) => {
      state.stops.push({
        ...orig,
        stop_id: newId,
        stop_code: undefined,
        stop_name: orig.stop_name ? `${orig.stop_name} (copy)` : orig.stop_name,
        stop_lat: orig.stop_lat + 0.0002,
        stop_lon: orig.stop_lon + 0.0002,
      });
    });
    return newId;
  },
  fillMissingWheelchairBoarding: (stopIds, value) => {
    const ids = new Set(stopIds);
    const changed: WheelchairFill[] = [];
    set((state) => {
      for (const s of state.stops) {
        if (!ids.has(s.stop_id)) continue;
        const cur = s.wheelchair_boarding;
        // Never overwrite a stop that already declares accessibility (1 or 2).
        if (cur === 1 || cur === 2) continue;
        changed.push({ stop_id: s.stop_id, prev: Number.isFinite(cur) ? cur : 0 });
        s.wheelchair_boarding = value;
      }
    });
    return changed;
  },
  restoreWheelchairBoarding: (entries) => set((state) => {
    const prevById = new Map(entries.map((e) => [e.stop_id, e.prev]));
    for (const s of state.stops) {
      const prev = prevById.get(s.stop_id);
      if (prev !== undefined) s.wheelchair_boarding = prev;
    }
  }),
  removeStopWithSnapshot: (stop_id) => {
    const snapshot: StopRemovalSnapshot = {
      stop: undefined, stopTimes: [], routeStops: [], transfers: [], translations: [],
      pathways: [], stopAreas: [], childStopIds: [], flexMemberships: [],
    };
    set((state) => {
      // Capture a clean (pre-mutation) view of the store via get() so we store
      // plain objects rather than immer draft proxies.
      const cur = get() as unknown as CrossSliceState;
      snapshot.stop = cur.stops.find((s) => s.stop_id === stop_id);
      if (!snapshot.stop) return;
      snapshot.stopTimes = cur.stopTimes.filter((st) => st.stop_id === stop_id);
      snapshot.routeStops = cur.routeStops.filter((rs) => rs.stop_id === stop_id);
      snapshot.transfers = (cur.transfers ?? []).filter(
        (t) => t.from_stop_id === stop_id || t.to_stop_id === stop_id,
      );
      snapshot.translations = translationsForRecords(cur.translations, 'stops', new Set([stop_id]));
      snapshot.pathways = (cur.pathways ?? []).filter(
        (p) => p.from_stop_id === stop_id || p.to_stop_id === stop_id,
      );
      snapshot.stopAreas = (cur.stopAreas ?? []).filter((sa) => sa.stop_id === stop_id);
      snapshot.childStopIds = cur.stops
        .filter((s) => s.parent_station === stop_id)
        .map((s) => s.stop_id);
      snapshot.flexMemberships = (cur.flexZones ?? []).flatMap((z) => {
        const index = z.stopIds?.indexOf(stop_id) ?? -1;
        return index === -1 ? [] : [{ zoneId: z.id, index }];
      });
      // Mutate draft — the same cascade removeStop runs.
      state.stops = cur.stops.filter((s) => s.stop_id !== stop_id);
      cascadeStopRemoval(state, new Set([stop_id]));
    });
    return snapshot;
  },
  restoreStop: (snapshot) => set((state) => {
    if (!snapshot.stop) return;
    const cur = get() as unknown as CrossSliceState;
    state.stops.push(snapshot.stop);
    (state as CrossSliceState).stopTimes = [...cur.stopTimes, ...snapshot.stopTimes];
    (state as CrossSliceState).routeStops = [...cur.routeStops, ...snapshot.routeStops];
    const cross = state as CrossSliceState;
    if (cross.transfers) {
      cross.transfers = [...(cur.transfers ?? []), ...snapshot.transfers];
    }
    if (snapshot.translations && snapshot.translations.length > 0) {
      cross.translations = [...(cur.translations ?? []), ...snapshot.translations];
    }
    const stopId = snapshot.stop.stop_id;
    if (cross.pathways && snapshot.pathways && snapshot.pathways.length > 0) {
      cross.pathways = [...(cur.pathways ?? []), ...snapshot.pathways];
    }
    if (cross.stopAreas && snapshot.stopAreas && snapshot.stopAreas.length > 0) {
      cross.stopAreas = [...(cur.stopAreas ?? []), ...snapshot.stopAreas];
    }
    if (snapshot.childStopIds && snapshot.childStopIds.length > 0) {
      const children = new Set(snapshot.childStopIds);
      for (const s of state.stops) {
        if (children.has(s.stop_id) && !s.parent_station) s.parent_station = stopId;
      }
    }
    for (const m of snapshot.flexMemberships ?? []) {
      const zone = cross.flexZones?.find((z) => z.id === m.zoneId);
      if (!zone || zone.stopIds?.includes(stopId)) continue;
      const list = zone.stopIds ?? [];
      list.splice(Math.min(m.index, list.length), 0, stopId);
      zone.stopIds = list;
    }
  }),
  setStops: (stops) => set((state) => { state.stops = stops; }),
});
