import { db } from './dexie';
import { useStore } from '../store';
import { loadingFeed } from '../store/history';
import type { StopTime, Shape, RouteStop, Trip } from '../types/gtfs';
import { repairRouteStops } from '../services/routeStopMigration';
// The persisted-key list lives in the store (a leaf module) because the store
// middleware needs it to decide when an edit makes the project dirty. Keeping
// one definition is what stops the dirty flag, the IndexedDB snapshot and the
// server snapshot from drifting apart.
import { SMALL_KEYS, DATA_KEYS } from '../store/persistedKeys';

// Reference tracking so we skip the (potentially huge) bulk write when only
// small tables changed. The store replaces these arrays by reference on edit,
// so an identity check is a reliable "did stop_times/shapes change?" signal.
let lastBulkProjectId: string | null = null;
let lastSavedStopTimes: StopTime[] | null = null;
let lastSavedShapes: Shape[] | null = null;

// localStorage key for the most recently autosaved anonymous projectId.
// EditorRoute reads this on mount so refresh / reopen restores the draft —
// otherwise the random projectId the store initializes with on each load
// would never match the autosaved row in IndexedDB and the data would
// silently orphan.
export const LAST_PROJECT_KEY = 'gtfs:lastProjectId';

export async function saveProject() {
  const state = useStore.getState();
  const snapshot: Record<string, unknown> = {};
  for (const key of SMALL_KEYS) {
    snapshot[key] = state[key];
  }

  await db.projects.put({
    id: state.projectId,
    name: state.projectName,
    lastModified: Date.now(),
  });

  // Store the small-tables snapshot as a structured object — IndexedDB
  // clones it natively, so we never build a multi-hundred-MB JSON string.
  await db.projectData.put({
    projectId: state.projectId,
    storeSnapshot: snapshot,
  });

  // Only rewrite the heavy stop_times/shapes record when it actually changed
  // (or when we've switched projects). Routine edits never touch it, so this
  // turns the per-second autosave from "re-serialize the whole feed" into a
  // cheap small-snapshot write.
  const bulkChanged =
    state.projectId !== lastBulkProjectId ||
    state.stopTimes !== lastSavedStopTimes ||
    state.shapes !== lastSavedShapes;
  if (bulkChanged) {
    await db.projectBulk.put({
      projectId: state.projectId,
      stopTimes: state.stopTimes,
      shapes: state.shapes,
    });
    lastBulkProjectId = state.projectId;
    lastSavedStopTimes = state.stopTimes;
    lastSavedShapes = state.shapes;
  }

  // Remember which anonymous draft this tab was editing so the next page
  // load (refresh, browser restart, or just reopening the tab) reloads
  // the same project from IndexedDB instead of a fresh empty one.
  try {
    localStorage.setItem(LAST_PROJECT_KEY, state.projectId);
  } catch {
    // Storage quota / private mode — losing the pointer just means the
    // refreshed tab won't auto-restore; the draft is still in IndexedDB.
  }

  // The user-visible "Saved / Unsaved changes" indicator tracks BACKEND save
  // state, not the local IndexedDB cache — anonymous users have nothing
  // backed up in the cloud even after autosave completes. Server-backed save
  // markSaved happens in serverPersistence.saveProjectNow. We just log the
  // local-cache write so devs can confirm IDB autosave is healthy from the
  // console without polluting the UI.
  console.debug(
    '[idb-autosave] Saved snapshot',
    { projectId: state.projectId, t: new Date().toISOString() },
  );
}

export async function loadProject(projectId: string) {
  const data = await db.projectData.get(projectId);
  if (!data) return false;

  // v2 rows store the snapshot as a structured object; legacy v1 rows store a
  // JSON string (with stopTimes/shapes inline). Handle both.
  const snapshot = typeof data.storeSnapshot === 'string'
    ? JSON.parse(data.storeSnapshot)
    : (data.storeSnapshot as Record<string, unknown> & {
        stopTimes?: StopTime[]; shapes?: Shape[];
      });
  const bulk = await db.projectBulk.get(projectId);
  // Prefer the dedicated bulk record; fall back to the inline arrays a legacy
  // snapshot still carries.
  const stopTimes = bulk?.stopTimes ?? snapshot.stopTimes;
  const shapes = bulk?.shapes ?? snapshot.shapes;
  // Set when the route_stop migrations repair the loaded pattern — the store
  // then holds something the cache doesn't, so the project must end up dirty
  // rather than clean (see RouteStopRepair.repaired).
  let repaired = false;
  // Loading a different feed must not be undoable across the boundary (#49):
  // suppress history capture during the bulk apply, then reset both stacks.
  loadingFeed(() => {
    const state = useStore.getState();

    if (snapshot.agencies) state.setAgencies(snapshot.agencies);
    if (snapshot.calendars) state.setCalendars(snapshot.calendars);
    if (snapshot.calendarDates) state.setCalendarDates(snapshot.calendarDates);
    if (snapshot.routes) state.setRoutes(snapshot.routes);
    if (snapshot.routeStops) {
      // Backfill shape_id on stops saved before per-shape keying, then cover any
      // stop_times the pattern is missing a column for (shared with the server
      // load path so the two can't drift — see routeStopMigration).
      const trips = (snapshot.trips ?? []) as Trip[];
      const fixed = repairRouteStops(
        snapshot.routeStops as RouteStop[],
        trips,
        (stopTimes ?? []) as StopTime[],
      );
      repaired = fixed.repaired;
      state.setRouteStops(fixed.routeStops);
    }
    if (snapshot.stops) state.setStops(snapshot.stops);
    if (snapshot.trips) state.setTrips(snapshot.trips);
    if (stopTimes) state.setStopTimes(stopTimes);
    if (shapes) state.setShapes(shapes);
    if (snapshot.feedInfo !== undefined) state.setFeedInfo(snapshot.feedInfo);
    if (snapshot.fareAttributes) state.setFareAttributes(snapshot.fareAttributes);
    if (snapshot.fareRules) state.setFareRules(snapshot.fareRules);
    if (snapshot.fareAreas) state.setFareAreas(snapshot.fareAreas);
    if (snapshot.stopAreas) state.setStopAreas(snapshot.stopAreas);
    if (snapshot.fareNetworks) state.setFareNetworks(snapshot.fareNetworks);
    if (snapshot.routeNetworks) state.setRouteNetworks(snapshot.routeNetworks);
    if (snapshot.timeframes) state.setTimeframes(snapshot.timeframes);
    if (snapshot.riderCategories) state.setRiderCategories(snapshot.riderCategories);
    if (snapshot.fareMedia) state.setFareMedia(snapshot.fareMedia);
    if (snapshot.fareProducts) state.setFareProducts(snapshot.fareProducts);
    if (snapshot.fareLegRules) state.setFareLegRules(snapshot.fareLegRules);
    if (snapshot.fareTransferRules) state.setFareTransferRules(snapshot.fareTransferRules);
    if (snapshot.frequencies) state.setFrequencies(snapshot.frequencies);
    if (snapshot.levels) state.setLevels(snapshot.levels);
    if (snapshot.pathways) state.setPathways(snapshot.pathways);
    if (snapshot.flexZones) state.setFlexZones(snapshot.flexZones);
    // transfers.txt (#67). Set unconditionally (like dismissedValidations) so
    // switching drafts in one session can't leak feed A's transfers into a feed
    // B whose local snapshot predates this key — an older/newer feed loads with
    // its own (or empty) transfers rather than inheriting the previous one's.
    state.setTransfers(Array.isArray(snapshot.transfers) ? snapshot.transfers : []);
    if (snapshot.featureSettings) state.setFeatureSettings(snapshot.featureSettings);
    // Per-feed dismissed validation rules. Set unconditionally (not `if present`)
    // so switching between drafts in one session can't leak feed A's dismissals
    // into a feed B whose snapshot predates this key — a brand-new/older feed
    // shows the warning again.
    state.setDismissedValidations(
      Array.isArray(snapshot.dismissedValidations) ? snapshot.dismissedValidations : [],
    );
    // Older local snapshots may still carry a `visibilitySets` key (the removed
    // "Scenarios" feature); it's intentionally ignored.
    if (snapshot.projectName) state.setProjectName(snapshot.projectName);
    if (snapshot.projectId) state.setProjectId(snapshot.projectId);
    if (typeof snapshot.licenseSpdx === 'string') state.setLicenseSpdx(snapshot.licenseSpdx);
    if (typeof snapshot.mdbSourceId === 'number') state.setMdbSourceId(snapshot.mdbSourceId);

    // Seed the bulk-write trackers to the just-loaded references so the next
    // autosave doesn't needlessly rewrite stop_times/shapes we only just read.
    const loaded = useStore.getState();
    lastBulkProjectId = projectId;
    lastSavedStopTimes = loaded.stopTimes;
    lastSavedShapes = loaded.shapes;

    state.markSaved();
    // A repaired pattern is a real, unsaved difference from what's on disk —
    // assert it AFTER markSaved() so the editor offers to persist the fix
    // instead of silently re-doing it on every open.
    if (repaired) state.markDirty();
  });
  return true;
}

export async function listProjects() {
  return await db.projects.toArray();
}

// Auto-save setup
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// Idempotent: every editor route mounts with `useEffect(() => setupAutoSave())`,
// but only the first call wires the store subscription. Subsequent calls
// (e.g. ServerEditorRoute mounting after SaveAsDialog navigates away from
// EditorRoute, before EditorRoute's cleanup fully runs in some race
// scenarios) hand back the same unsubscribe so we never end up with two
// subscriptions writing to IndexedDB on every keystroke.
//
// This subscription schedules the local IndexedDB write and NOTHING ELSE. It
// deliberately no longer owns the `isDirty` flag: dirtiness is now stamped on
// the store's own write path (store/historyMiddleware.ts), because tying it to
// a ref-counted, mount-scoped subscription meant any moment with no editor
// route holding a reference silently swallowed edits and left Save disabled.
let activeUnsub: (() => void) | null = null;
let activeRefs = 0;

export function setupAutoSave(): () => void {
  activeRefs += 1;
  if (!activeUnsub) {
    activeUnsub = useStore.subscribe((state, prevState) => {
      // Check if any data changed (not just UI state)
      const dataChanged = DATA_KEYS.some((key) => state[key] !== prevState[key]);
      if (!dataChanged) return;

      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        // Skip the IndexedDB write when the editor is on a server-backed
        // project. The server is the source of truth there (saveProjectNow
        // handles persistence); writing to IDB only pollutes the "local feeds
        // available for import" list with copies of feeds that already live
        // on the server, which used to cause duplicate imports on /feeds.
        if (useStore.getState().activeServerProjectId) return;
        saveProject().catch(console.error);
      }, 1000);
    });
  }
  // Return a per-caller unsubscribe handle. Only when the last caller
  // releases do we actually tear down the underlying store subscription.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRefs -= 1;
    if (activeRefs <= 0) {
      activeRefs = 0;
      if (activeUnsub) {
        activeUnsub();
        activeUnsub = null;
      }
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
    }
  };
}
