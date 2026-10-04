// Store-mutating GTFS import helpers. The pure parser (importGtfsZip,
// inspectGtfsZip) lives in gtfsParse.ts so it can run in a Web Worker; we
// re-export it here so existing import sites keep importing from one place.
import { useStore } from '../store';
import { loadingFeed } from '../store/history';
import { asOneUndoStep } from './undoStep';
import { resetEditorState } from '../db/serverPersistence';
import type { AdvancedFeature } from '../store/featuresSlice';
import type { Calendar, CalendarDate, Translation } from '../types/gtfs';
import { translationKey } from './translations';
import { allServiceIds } from './serviceIds';
import {
  importGtfsZip,
  inspectGtfsZip,
  LARGE_FEED_BYTES,
  type ImportData,
  type ImportProgress,
  type ImportWorkerResponse,
} from './gtfsParse';

export { importGtfsZip, inspectGtfsZip, LARGE_FEED_BYTES };
export type { ImportData, ImportProgress };

/** Parse a GTFS zip in a Web Worker so the main thread stays responsive on
 * large feeds. Falls back to the main-thread parse if Workers are unavailable.
 * Progress callbacks fire on phase changes (and every ~250k stop_times rows). */
export function parseGtfsInWorker(
  file: File,
  onProgress?: ImportProgress,
): Promise<ImportData> {
  if (typeof Worker === 'undefined') {
    return importGtfsZip(file, onProgress);
  }
  return new Promise<ImportData>((resolve, reject) => {
    const worker = new Worker(new URL('./gtfsImport.worker.ts', import.meta.url), {
      type: 'module',
    });
    const done = (fn: () => void) => { worker.terminate(); fn(); };
    worker.onmessage = (e: MessageEvent<ImportWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.({ phase: msg.phase, rows: msg.rows });
      else if (msg.type === 'result') done(() => resolve(msg.data));
      else if (msg.type === 'error') done(() => reject(new Error(msg.message)));
    };
    worker.onerror = (e) => done(() => reject(new Error(e.message || 'Import worker failed')));
    worker.postMessage({ file });
  });
}

export function loadImportIntoStore(data: Awaited<ReturnType<typeof importGtfsZip>>) {
  // Loading a different feed must not be undoable across the boundary (#49):
  // suppress history capture during the bulk load, then reset both stacks.
  loadingFeed(() => applyImportToStore(data));
}

function applyImportToStore(data: Awaited<ReturnType<typeof importGtfsZip>>) {
  // Clean-slate the editor before loading the imported feed so no selection,
  // in-progress drawing/editing, visibility filter, derived overlay, or
  // leftover entity from the previous project survives a "Replace project"
  // import. This makes a replace-import behave identically to the server load
  // path (applySnapshotToStore) — one shared reset, no drift (#42).
  resetEditorState();

  const store = useStore.getState();
  store.setAgencies(data.agencies);
  store.setCalendars(data.calendars);
  store.setCalendarDates(data.calendarDates);
  store.setRoutes(data.routes);
  store.setShapes(data.shapes);
  store.setStops(data.stops);
  store.setTrips(data.trips);
  store.setStopTimes(data.stopTimes);
  store.setFeedInfo(data.feedInfo);
  store.setRouteStops(data.routeStops);
  store.setFareAttributes(data.fareAttributes);
  store.setFareRules(data.fareRules);
  store.setTransfers(data.transfers);
  store.setFrequencies(data.frequencies);
  store.setLevels(data.levels);
  store.setPathways(data.pathways);
  store.setFareAreas(data.fareAreas);
  store.setStopAreas(data.stopAreas);
  store.setFareNetworks(data.fareNetworks);
  store.setRouteNetworks(data.routeNetworks);
  store.setTimeframes(data.timeframes);
  store.setRiderCategories(data.riderCategories);
  store.setFareMedia(data.fareMedia);
  store.setFareProducts(data.fareProducts);
  store.setFareLegRules(data.fareLegRules);
  store.setFareTransferRules(data.fareTransferRules);
  store.setFlexZones(data.flexZones);
  store.setTranslations(data.translations);

  // Seed per-feed feature settings from what the imported feed contains, so its
  // advanced sections (frequencies, stations, transfers) show up — "the feed
  // contains the file" enables the feature. demandResponse is left unset so it
  // stays on by default. Blocks is intentionally NOT seeded: block_id is too
  // niche to auto-surface a nav section, so it stays off until the user opts in
  // (the data is preserved and still exports regardless).
  const fs: Partial<Record<AdvancedFeature, boolean>> = {};
  if (data.transfers.length) fs.transfers = true;
  if (data.frequencies.length) fs.frequencies = true;
  if (data.levels.length || data.pathways.length) fs.stations = true;
  if (data.translations.length) fs.translations = true;
  // Fares v2: auto-on when the imported feed already carries any v2 file, so
  // its authoring tabs surface without the user hunting for the toggle.
  if (
    data.fareAreas.length || data.stopAreas.length ||
    data.fareNetworks.length || data.routeNetworks.length ||
    data.timeframes.length || data.riderCategories.length ||
    data.fareMedia.length || data.fareProducts.length ||
    data.fareLegRules.length || data.fareTransferRules.length
  ) {
    fs.faresV2 = true;
  }
  store.setFeatureSettings(fs);

  // A freshly imported feed starts with nothing dismissed — validation
  // dismissals are per-feed, so the new feed surfaces every applicable rule.
  store.setDismissedValidations([]);
}

type ServiceDef = {
  calendars: readonly Calendar[];
  calendarDates: readonly CalendarDate[];
};

/** A service's full definition: weekday bits + date range (when it has a
 *  calendar row) + its sorted calendar_dates. Two services are "the same" only
 *  when these match exactly — a shared weekday pattern alone is not enough. */
function serviceSignature(id: string, src: ServiceDef): string {
  const c = src.calendars.find((x) => x.service_id === id);
  const cal = c
    ? `${c.monday}${c.tuesday}${c.wednesday}${c.thursday}${c.friday}${c.saturday}${c.sunday}|${c.start_date}|${c.end_date}`
    : 'nocal';
  const dates = src.calendarDates
    .filter((d) => d.service_id === id)
    .map((d) => `${d.date}:${d.exception_type}`)
    .sort()
    .join(',');
  return `${cal}#${dates}`;
}

/**
 * Merge selected routes (and their associated stops, parent stations, levels,
 * trips, stop times, frequencies, shapes, services and route-stop
 * associations) from an imported feed into the existing project. Agency info
 * and fares are NOT imported; a route whose agency_id the project doesn't have
 * is attached to the project's first agency.
 *
 * Ids: when any imported id collides with an existing one of the same kind, a
 * prefix (`i2_`, `i3_`, …) is applied to ALL imported ids — routes, stops,
 * trips, shapes, services, blocks and levels — chosen so that no prefixed id
 * collides in any kind. Imported stops that match an existing stop by name and
 * location reuse it; an imported service whose FULL definition (weekdays, date
 * range and calendar_dates) matches an existing one reuses it.
 *
 * The whole merge is a single undo step.
 */
export function mergeImportIntoStore(
  data: Awaited<ReturnType<typeof importGtfsZip>>,
  selectedRouteIds: Set<string>,
) {
  const store = useStore.getState();
  const srcCalendars = data.calendars ?? [];
  const srcCalendarDates = data.calendarDates ?? [];
  const srcFrequencies = data.frequencies ?? [];
  const srcLevels = data.levels ?? [];

  // ── What comes across ────────────────────────────────────────────────────
  const selectedRoutes  = data.routes.filter((r) => selectedRouteIds.has(r.route_id));
  const selRouteGtfsIds = new Set(selectedRoutes.map((r) => r.route_id));
  const selectedTrips   = data.trips.filter((t) => selRouteGtfsIds.has(t.route_id));
  const selTripGtfsIds  = new Set(selectedTrips.map((t) => t.trip_id));
  const selectedStopTimes = data.stopTimes.filter((st) => selTripGtfsIds.has(st.trip_id));
  const selectedRouteStops = data.routeStops.filter((rs) => selRouteGtfsIds.has(rs.route_id));
  const selectedFrequencies = srcFrequencies.filter((f) => selTripGtfsIds.has(f.trip_id));

  // Stop remap: an imported stop matching an existing one by name + location
  // reuses it.
  const stopIdRemap = new Map<string, string>();
  for (const importedStop of data.stops) {
    for (const existingStop of store.stops) {
      const sameName = existingStop.stop_name === importedStop.stop_name;
      const sameLat = Math.abs(existingStop.stop_lat - importedStop.stop_lat) < 0.0001;
      const sameLon = Math.abs(existingStop.stop_lon - importedStop.stop_lon) < 0.0001;
      if (sameName && sameLat && sameLon) {
        stopIdRemap.set(importedStop.stop_id, existingStop.stop_id);
        break;
      }
    }
  }

  // Needed stops: served by the selected trips / route stops, plus their
  // parent stations (transitively), so parent_station never dangles.
  const srcStopById = new Map(data.stops.map((s) => [s.stop_id, s]));
  const neededStopIds = new Set([
    ...selectedStopTimes.map((st) => st.stop_id),
    ...selectedRouteStops.map((rs) => rs.stop_id),
  ]);
  const queue = [...neededStopIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (stopIdRemap.has(id)) continue; // reusing a host stop: keep the host's parent
    const parent = srcStopById.get(id)?.parent_station;
    if (parent && !neededStopIds.has(parent) && srcStopById.has(parent)) {
      neededStopIds.add(parent);
      queue.push(parent);
    }
  }
  const selectedStops = data.stops.filter((s) => neededStopIds.has(s.stop_id) && !stopIdRemap.has(s.stop_id));
  const neededLevelIds = new Set(selectedStops.map((s) => s.level_id).filter(Boolean) as string[]);
  const selectedLevels = srcLevels.filter((l) => neededLevelIds.has(l.level_id));

  const neededShapeIds = new Set([
    ...selectedTrips.map((t) => t.shape_id),
    ...selectedRouteStops.map((rs) => rs.shape_id),
  ].filter(Boolean) as string[]);
  const selectedShapes = data.shapes.filter((s) => neededShapeIds.has(s.shape_id));

  // Services: reuse a host service only when its full definition matches.
  const hostServices: ServiceDef = { calendars: store.calendars, calendarDates: store.calendarDates };
  const srcServices: ServiceDef = { calendars: srcCalendars, calendarDates: srcCalendarDates };
  const hostBySignature = new Map<string, string>();
  for (const id of allServiceIds(hostServices)) {
    const sig = serviceSignature(id, hostServices);
    if (!hostBySignature.has(sig)) hostBySignature.set(sig, id);
  }
  const neededServiceIds = new Set(selectedTrips.map((t) => t.service_id));
  const serviceIdRemap = new Map<string, string>();
  for (const id of neededServiceIds) {
    const hostId = hostBySignature.get(serviceSignature(id, srcServices));
    if (hostId !== undefined) serviceIdRemap.set(id, hostId);
  }
  const importedServiceIds = [...neededServiceIds].filter((id) => !serviceIdRemap.has(id));
  const neededBlockIds = new Set(selectedTrips.map((t) => t.block_id).filter(Boolean) as string[]);

  // ── Prefix: collision-free across every id kind ──────────────────────────
  const kinds: { existing: Set<string>; incoming: string[] }[] = [
    { existing: new Set(store.routes.map((r) => r.route_id)), incoming: selectedRoutes.map((r) => r.route_id) },
    { existing: new Set(store.stops.map((s) => s.stop_id)), incoming: selectedStops.map((s) => s.stop_id) },
    { existing: new Set(store.trips.map((t) => t.trip_id)), incoming: selectedTrips.map((t) => t.trip_id) },
    { existing: new Set(store.shapes.map((s) => s.shape_id)), incoming: selectedShapes.map((s) => s.shape_id) },
    { existing: allServiceIds(hostServices), incoming: importedServiceIds },
    { existing: new Set(store.trips.map((t) => t.block_id).filter(Boolean) as string[]), incoming: [...neededBlockIds] },
    { existing: new Set((store.levels ?? []).map((l) => l.level_id)), incoming: selectedLevels.map((l) => l.level_id) },
  ];
  const collides = (p: string) => kinds.some((k) => k.incoming.some((id) => k.existing.has(p + id)));
  let prefix = '';
  if (collides('')) {
    for (let i = 2; i <= 99; i++) {
      if (!collides(`i${i}_`)) { prefix = `i${i}_`; break; }
    }
    if (!prefix) prefix = `imp${Date.now()}_`;
  }
  const pfx = (id: string) => (prefix ? prefix + id : id);
  const remapStopId = (id: string) => stopIdRemap.get(id) ?? pfx(id);
  const remapServiceId = (id: string) => serviceIdRemap.get(id) ?? pfx(id);

  const hostAgencyIds = new Set(store.agencies.map((a) => a.agency_id));
  const fallbackAgencyId = store.agencies[0]?.agency_id;
  const remapAgencyId = (id: string) =>
    hostAgencyIds.has(id) || fallbackAgencyId === undefined ? id : fallbackAgencyId;

  // translations.txt for what came across: record-based rows of the merged
  // routes, trips (+ their stop_times) and newly added stops, re-keyed to the
  // prefixed ids; and by-value rows (e.g. a headsign) whose value one of the
  // merged records actually carries. Rows already present aren't repeated.
  const mergedStopIds = new Set(selectedStops.map((st) => st.stop_id));
  const valuesByTable: Record<string, Record<string, unknown>[]> = {
    routes: selectedRoutes as unknown as Record<string, unknown>[],
    trips: selectedTrips as unknown as Record<string, unknown>[],
    stop_times: selectedStopTimes as unknown as Record<string, unknown>[],
    stops: selectedStops as unknown as Record<string, unknown>[],
  };
  const carried: Translation[] = [];
  for (const t of data.translations ?? []) {
    if (t.record_id && !t.field_value) {
      const id = t.record_id;
      const keep =
        (t.table_name === 'routes' && selRouteGtfsIds.has(id)) ||
        ((t.table_name === 'trips' || t.table_name === 'stop_times') && selTripGtfsIds.has(id)) ||
        (t.table_name === 'stops' && mergedStopIds.has(id));
      if (keep) carried.push({ ...t, record_id: pfx(id) });
    } else if (t.field_value && valuesByTable[t.table_name]) {
      if (valuesByTable[t.table_name].some((r) => String(r[t.field_name] ?? '') === t.field_value)) {
        carried.push({ ...t });
      }
    }
  }

  // ── Apply, as one undo step ──────────────────────────────────────────────
  asOneUndoStep(() => {
    const s = useStore.getState();
    s.setRoutes([
      ...s.routes,
      ...selectedRoutes.map((route) => ({
        ...route,
        route_id: pfx(route.route_id),
        agency_id: remapAgencyId(route.agency_id),
      })),
    ]);
    s.setStops([
      ...s.stops,
      ...selectedStops.map((stop) => ({
        ...stop,
        stop_id: pfx(stop.stop_id),
        parent_station: stop.parent_station ? remapStopId(stop.parent_station) : stop.parent_station,
        level_id: stop.level_id ? pfx(stop.level_id) : stop.level_id,
      })),
    ]);
    if (selectedLevels.length > 0) {
      s.setLevels([...(s.levels ?? []), ...selectedLevels.map((l) => ({ ...l, level_id: pfx(l.level_id) }))]);
    }
    s.setTrips([
      ...s.trips,
      ...selectedTrips.map((trip) => ({
        ...trip,
        trip_id: pfx(trip.trip_id),
        route_id: pfx(trip.route_id),
        service_id: remapServiceId(trip.service_id),
        shape_id: trip.shape_id ? pfx(trip.shape_id) : undefined,
        block_id: trip.block_id ? pfx(trip.block_id) : undefined,
      })),
    ]);
    s.setStopTimes([
      ...s.stopTimes,
      ...selectedStopTimes.map((st) => ({
        ...st,
        trip_id: pfx(st.trip_id),
        stop_id: remapStopId(st.stop_id),
      })),
    ]);
    if (selectedFrequencies.length > 0) {
      s.setFrequencies([
        ...(s.frequencies ?? []),
        ...selectedFrequencies.map((f) => ({ ...f, trip_id: pfx(f.trip_id) })),
      ]);
    }
    s.setShapes([...s.shapes, ...selectedShapes.map((shape) => ({ ...shape, shape_id: pfx(shape.shape_id) }))]);
    // Route-stop associations. shape_id MUST be prefixed to match the imported
    // trips' + shapes' prefixed shape_id — otherwise the timetable's
    // orderedStops (which filters routeStops by the trips' shape_id) finds
    // nothing and shows "Add stops to this route first".
    s.setRouteStops([
      ...useStore.getState().routeStops,
      ...selectedRouteStops.map((rs) => ({
        ...rs,
        route_id: pfx(rs.route_id),
        stop_id: remapStopId(rs.stop_id),
        shape_id: rs.shape_id ? pfx(rs.shape_id) : rs.shape_id,
      })),
    ]);
    // Services that weren't matched to a host service: their calendar row (if
    // any) and ALL their calendar_dates — a calendar_dates-only service has no
    // calendar row and would otherwise arrive with no dates at all.
    const imported = new Set(importedServiceIds);
    const calendarsToAdd = srcCalendars
      .filter((c) => imported.has(c.service_id))
      .map((c) => ({ ...c, service_id: pfx(c.service_id) }));
    if (calendarsToAdd.length > 0) {
      const now = useStore.getState();
      now.setCalendars([...now.calendars, ...calendarsToAdd]);
    }
    const datesToAdd = srcCalendarDates
      .filter((d) => imported.has(d.service_id))
      .map((d) => ({ ...d, service_id: pfx(d.service_id) }));
    if (datesToAdd.length > 0) {
      const now = useStore.getState();
      now.setCalendarDates([...now.calendarDates, ...datesToAdd]);
    }
    if (carried.length > 0) {
      const now = useStore.getState();
      const have = new Set(now.translations.map(translationKey));
      const fresh = carried.filter((t) => {
        const k = translationKey(t);
        if (have.has(k)) return false;
        have.add(k);
        return true;
      });
      if (fresh.length > 0) now.setTranslations([...now.translations, ...fresh]);
    }
  });

  // Surface the merged tables' editors (feature toggles aren't undoable data).
  const fs = { ...useStore.getState().featureSettings };
  let fsChanged = false;
  if (selectedFrequencies.length > 0 && !fs.frequencies) { fs.frequencies = true; fsChanged = true; }
  if (selectedLevels.length > 0 && !fs.stations) { fs.stations = true; fsChanged = true; }
  if (fsChanged) useStore.getState().setFeatureSettings(fs);
}
