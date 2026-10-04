import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { ensureDefaultCalendar } from '../../services/defaultCalendar';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { computeTimetablePatterns, isNoShapeBucket } from '../ui/shapePatterns';
import { earliestDepartureDirection, needsDefaultCalendar, resolveActiveServiceId, sortTripsByStart, timepointSeqs as computeTimepointSeqs, tripStartSec } from './timetableGridHelpers';
import { allServiceIds } from '../../services/serviceIds';
import { gtfsTimeToSeconds } from '../../utils/time';
import type { Stop, StopTime } from '../../types/gtfs';

/** A resolved scope for one timetable pane. The main pane's scope proxies the
 *  global `timetable*` store fields; the companion pane's is derived (same route
 *  + service, opposite direction / chosen pattern). */
export interface PaneScope {
  routeId: string | null;
  directionId: 0 | 1;
  serviceId: string | null;
  shapeId: string | null;
}

export interface OrderedStop {
  uid: string;
  seq: number;
  stop: Stop;
}

/** All read-derived data a timetable pane needs, computed from a scope. Extracted
 *  from the old monolithic TimetableGrid so the main and companion panes each
 *  derive independently. When `syncSelection` is true (main pane only) it also
 *  keeps the global shape/direction selection valid and auto-creates a calendar
 *  if the feed has none — the companion pane is fully derived and does neither. */
export function useTimetableData(scope: PaneScope, syncSelection: boolean) {
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const shapes = useStore((s) => s.shapes);
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const setSelectedShapeId = useStore((s) => s.setTimetableShapeId);
  const setDirectionId = useStore((s) => s.setTimetableDirectionId);
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const { routeId, directionId, serviceId, shapeId } = scope;
  const route = routes.find((r) => r.route_id === routeId);

  // Safety net: a feed with no service at all (neither calendar.txt nor
  // calendar_dates.txt) gets a default calendar (main pane only). A
  // calendar_dates-only feed already has services and is left alone.
  useEffect(() => {
    if (!syncSelection) return;
    if (!needsDefaultCalendar({ calendars, calendarDates })) return;
    if (!routeId || routes.length === 0) return;
    ensureDefaultCalendar();
  }, [syncSelection, calendars, calendarDates, routeId, routes.length]);

  // Services come from calendar.txt ∪ calendar_dates.txt (a dates-only service
  // is a real service). Calendar rows first, then dates-only ids.
  const serviceIdList = useMemo(() => [...allServiceIds({ calendars, calendarDates })], [calendars, calendarDates]);
  const activeServiceId = useMemo(() => resolveActiveServiceId(serviceId, serviceIdList), [serviceId, serviceIdList]);

  const patterns = useMemo(
    () => computeTimetablePatterns(routeId, trips, routeStops, shapes),
    [routeId, trips, routeStops, shapes],
  );

  // The direction a fresh route defaults to: whichever begins service first (by
  // earliest first departure of the active service). Only used when there's no
  // valid current selection — an explicit pick keeps the shape valid and wins.
  const defaultDirection = useMemo(() => {
    if (!routeId) return 0 as 0 | 1;
    const rows = trips
      .filter((t) => t.route_id === routeId && (!activeServiceId || t.service_id === activeServiceId))
      .map((t) => {
        const sts = (stopTimesByTrip.get(t.trip_id) ?? [])
          .filter((s) => s.arrival_time || s.departure_time)
          .sort((a, b) => a.stop_sequence - b.stop_sequence);
        const first = sts[0];
        return { directionId: t.direction_id, firstSec: first ? gtfsTimeToSeconds(first.departure_time || first.arrival_time) : null };
      });
    return earliestDepartureDirection(rows);
  }, [routeId, trips, activeServiceId, stopTimesByTrip]);

  // The default pattern to land on: prefer one in the earliest-departure
  // direction, else the first pattern.
  const defaultPattern = useMemo(
    () => patterns.find((p) => p.directionId === defaultDirection) ?? patterns[0],
    [patterns, defaultDirection],
  );

  // Main pane: keep the stored shape/direction pointing at a valid pattern.
  useEffect(() => {
    if (!syncSelection) return;
    if (patterns.length === 0) {
      if (shapeId !== null) setSelectedShapeId(null);
      return;
    }
    const current = patterns.find((p) => p.shapeId === shapeId);
    if (!current && defaultPattern) {
      setSelectedShapeId(defaultPattern.shapeId);
      if (defaultPattern.directionId !== directionId) setDirectionId(defaultPattern.directionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSelection, routeId, patterns]);

  const effectiveShapeId = useMemo(() => {
    if (patterns.length === 0) return null;
    return patterns.some((p) => p.shapeId === shapeId) ? shapeId : (defaultPattern?.shapeId ?? patterns[0].shapeId);
  }, [patterns, shapeId, defaultPattern]);

  const noShapeBucket = isNoShapeBucket(effectiveShapeId);
  const realShapeIds = useMemo(
    () => new Set(patterns.filter((p) => !isNoShapeBucket(p.shapeId)).map((p) => p.shapeId)),
    [patterns],
  );

  const orderedStops: OrderedStop[] = useMemo(() => {
    if (!routeId) return [];
    const list = noShapeBucket
      ? routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId
          && (!rs.shape_id || !realShapeIds.has(rs.shape_id)))
      : effectiveShapeId
        ? routeStops.filter((rs) => rs.route_id === routeId && rs.shape_id === effectiveShapeId)
        : routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId);
    return [...list]
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => {
        const stop = stops.find((s) => s.stop_id === rs.stop_id);
        return stop ? { uid: rs._uid ?? `${rs.stop_id}-${rs.stop_sequence}`, seq: rs.stop_sequence, stop } : null;
      })
      .filter((x): x is OrderedStop => x !== null);
  }, [routeId, effectiveShapeId, directionId, routeStops, stops, noShapeBucket, realShapeIds]);

  const findStopTime = useCallback((tripId: string, seq: number): StopTime | undefined => {
    const list = stopTimesByTrip.get(tripId);
    return list?.find((st) => st.stop_sequence === seq);
  }, [stopTimesByTrip]);


  const continuousOverrides = useMemo(() => {
    const map = new Map<string, { pickup?: 0 | 1 | 2 | 3; dropOff?: 0 | 1 | 2 | 3 }>();
    if (routeId) {
      const routeTripIds = new Set(trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id));
      for (const tripId of routeTripIds) {
        for (const st of stopTimesByTrip.get(tripId) ?? []) {
          if (st.continuous_pickup === undefined && st.continuous_drop_off === undefined) continue;
          if (!map.has(st.stop_id)) map.set(st.stop_id, { pickup: st.continuous_pickup, dropOff: st.continuous_drop_off });
        }
      }
    }
    return map;
  }, [stopTimesByTrip, routeId, trips]);

  const routeTrips = useMemo(() => {
    if (!routeId) return [];
    const filtered = trips
      .filter((t) => t.route_id === routeId
        && (!activeServiceId || t.service_id === activeServiceId)
        && (noShapeBucket
          ? (t.direction_id === directionId && (!t.shape_id || !realShapeIds.has(t.shape_id)))
          : effectiveShapeId ? t.shape_id === effectiveShapeId : t.direction_id === directionId));
    // Numeric start-second order (string compare mis-orders unpadded 8:05:00
    // vs 10:00:00); untimed trips last.
    return sortTripsByStart(filtered, (id) => tripStartSec(stopTimesByTrip.get(id)));
  }, [routeId, trips, stopTimesByTrip, directionId, activeServiceId, effectiveShapeId, noShapeBucket, realShapeIds]);

  /** Start second of a trip (lowest-sequence timed stop), or null if untimed. */
  const getStartSec = useCallback(
    (tripId: string) => tripStartSec(stopTimesByTrip.get(tripId)),
    [stopTimesByTrip],
  );

  // Timepoint columns for THIS pane's trips, keyed by stop_sequence (a stop that
  // appears twice in a loop, or is a timepoint only on another service, doesn't
  // leak in). The first/last default applies per column only where none of the
  // pane's trips sets timepoint explicitly.
  const timepointSeqs = useMemo(
    () => computeTimepointSeqs(orderedStops.map((c) => c.seq), routeTrips.map((t) => t.trip_id), (id) => stopTimesByTrip.get(id)),
    [orderedStops, routeTrips, stopTimesByTrip],
  );

  const serviceIdsWithTrips = useMemo(() => {
    if (!routeId) return [];
    return [...new Set(
      trips.filter((t) => t.route_id === routeId && t.direction_id === directionId).map((t) => t.service_id),
    )];
  }, [routeId, trips, directionId]);

  // First non-blank displayed time for a trip (departure preferred at the origin).
  const getFirstDisplayedTime = useCallback((tripId: string) => {
    for (const col of orderedStops) {
      const st = findStopTime(tripId, col.seq);
      const t = st?.departure_time || st?.arrival_time;
      if (t) return t;
    }
    return '';
  }, [orderedStops, findStopTime]);

  return {
    route,
    patterns,
    activeServiceId,
    effectiveShapeId,
    noShapeBucket,
    realShapeIds,
    orderedStops,
    routeTrips,
    timepointSeqs,
    getStartSec,
    continuousOverrides,
    serviceIdsWithTrips,
    findStopTime,
    getFirstDisplayedTime,
    hasStops: orderedStops.length > 0,
  };
}
