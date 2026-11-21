// trips.wheelchair_accessible: per-trip and bulk set (Route → Trips tab), and
// the value surviving export → import.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../index';
import { resetHistory, undo } from '../history';
import type { Trip } from '../../types/gtfs';
import { exportGtfsZip } from '../../services/gtfsExport';
import { importGtfsZip } from '../../services/gtfsParse';
import { summarizeTripWheelchair, tripWheelchairValue } from '../../components/routes/tripWheelchair';

function trip(id: string, route: string, wa?: number): Trip {
  return { trip_id: id, route_id: route, service_id: 'wk', direction_id: 0, wheelchair_accessible: wa };
}

const waOf = (id: string) => useStore.getState().trips.find((t) => t.trip_id === id)!.wheelchair_accessible;

beforeEach(() => {
  const s = useStore.getState();
  s.setTrips([trip('a1', 'A'), trip('a2', 'A', 2), trip('b1', 'B', 0)]);
  resetHistory();
});

describe('setTripsWheelchairAccessible', () => {
  it('sets only the listed trips and overwrites what they had', () => {
    const n = useStore.getState().setTripsWheelchairAccessible(['a1', 'a2'], 1);
    expect(n).toBe(2);
    expect(waOf('a1')).toBe(1);
    expect(waOf('a2')).toBe(1);
    expect(waOf('b1')).toBe(0);
  });

  it("'all' sets every trip in the feed and counts only real changes", () => {
    useStore.getState().setTripsWheelchairAccessible(['a1'], 1);
    const n = useStore.getState().setTripsWheelchairAccessible('all', 1);
    expect(n).toBe(2);
    expect(useStore.getState().trips.every((t) => t.wheelchair_accessible === 1)).toBe(true);
  });

  it('returns 0 and changes nothing when every trip already has the value', () => {
    useStore.getState().setTripsWheelchairAccessible('all', 2);
    const before = useStore.getState().trips;
    expect(useStore.getState().setTripsWheelchairAccessible('all', 2)).toBe(0);
    expect(useStore.getState().trips).toBe(before);
  });

  it('a bulk set is one undo step', () => {
    useStore.getState().setTripsWheelchairAccessible('all', 1);
    undo();
    expect(waOf('a1')).toBeUndefined();
    expect(waOf('a2')).toBe(2);
    expect(waOf('b1')).toBe(0);
  });
});

describe('trip wheelchair helpers', () => {
  it('summarizes 1 / 2 / everything else', () => {
    expect(summarizeTripWheelchair([trip('x', 'A', 1), trip('y', 'A', 2), trip('z', 'A'), trip('w', 'A', 0), trip('v', 'A', 7)]))
      .toEqual({ accessible: 1, notAccessible: 1, unknown: 3 });
  });

  it('maps out-of-spec and blank values to 0 for the picker', () => {
    expect(tripWheelchairValue(trip('x', 'A'))).toBe(0);
    expect(tripWheelchairValue(trip('x', 'A', 7))).toBe(0);
    expect(tripWheelchairValue(trip('x', 'A', 2))).toBe(2);
  });
});

describe('wheelchair_accessible round trip', () => {
  it('exports the values set in the editor and imports them back', async () => {
    const s = useStore.getState();
    s.setAgencies([{ agency_id: 'X', agency_name: 'X', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
    s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
    s.setCalendarDates([]);
    s.setRoutes([
      { route_id: 'A', agency_id: 'X', route_short_name: 'A', route_type: 3 } as never,
      { route_id: 'B', agency_id: 'X', route_short_name: 'B', route_type: 3 } as never,
    ]);
    s.setStops([]);
    s.setStopTimes([]);
    s.setFlexZones([]);
    s.setFareAttributes([]);
    s.setFareRules([]);
    s.setTripsWheelchairAccessible(['a1'], 1);
    s.setTripsWheelchairAccessible(['b1'], 2);

    const bytes = new Uint8Array(await (await exportGtfsZip()).arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const csv = await zip.file('trips.txt')!.async('string');
    const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
    const byId = Object.fromEntries(rows.map((r) => [r.trip_id, r.wheelchair_accessible]));
    expect(byId).toEqual({ a1: '1', a2: '2', b1: '2' });

    const parsed = await importGtfsZip(bytes as unknown as File);
    const back = Object.fromEntries(parsed.trips.map((t) => [t.trip_id, t.wheelchair_accessible]));
    expect(back).toEqual({ a1: 1, a2: 2, b1: 2 });
  });
});
