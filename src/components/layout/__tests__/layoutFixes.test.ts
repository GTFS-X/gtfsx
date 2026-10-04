// Batch B7 layout fixes:
//   S1-14  calendar delete refused while referenced → the rail says why
//   C3-03  sign-out drops the loaded feed and local drafts (+ C4-15 staff hint)
//   C3-04  Routes badge counts mixed fixed + flex routes
//   C3-21  Discard & Reset lands on /editor with the store clean
//   C3-23  a hidden server-only bottom tab falls back to the timetable
//   C3-27  Fares badge counts Fares v2 products
//   C3-18  leaving /demo before the demo feed loads leaves the store alone
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cleared = vi.hoisted(() => ({ projects: 0, projectData: 0, projectBulk: 0 }));
vi.mock('../../../db/dexie', () => {
  const table = (name: keyof typeof cleared) => ({
    clear: async () => { cleared[name] += 1; },
    put: async () => undefined,
    get: async () => undefined,
    delete: async () => undefined,
    toArray: async () => [],
    where: () => ({ notEqual: () => ({ delete: async () => undefined }) }),
  });
  return {
    db: {
      projects: table('projects'),
      projectData: table('projectData'),
      projectBulk: table('projectBulk'),
      transaction: async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
    },
  };
});

const importMocks = vi.hoisted(() => ({
  importGtfsZip: vi.fn(),
  loadImportIntoStore: vi.fn(),
}));
vi.mock('../../../services/gtfsImport', async (orig) => ({
  ...(await orig<typeof import('../../../services/gtfsImport')>()),
  importGtfsZip: importMocks.importGtfsZip,
  loadImportIntoStore: importMocks.loadImportIntoStore,
}));

const { useStore } = await import('../../../store');
const { calendarReferences } = await import('../../../store/calendarSlice');
const { calendarDeleteBlockedMessage } = await import('../calendarDeleteMessage');
const { signOutLocally } = await import('../signOut');
const { visibleRouteCount, fareCount } = await import('../railCounts');
const { discardAndStartFresh, freshEditorUrl } = await import('../startFresh');
const { bottomPanelTabs, effectiveBottomTab } = await import('../bottomPanelTabs');
const { loadDemoFeed } = await import('../demoFeed');
const { STAFF_IMPERSONATOR_KEY } = await import('../../../services/adminApi');
import type { Calendar, Route, Trip } from '../../../types/gtfs';
import type { FlexZone } from '../../../store/flexSlice';

const s = () => useStore.getState();
const cal = (id: string): Calendar =>
  ({
    service_id: id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
  }) as Calendar;
const route = (id: string): Route =>
  ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const trip = (id: string, route_id: string, service_id = 'WK'): Trip =>
  ({ trip_id: id, route_id, service_id, direction_id: 0 }) as Trip;
const zone = (id: string, routeId?: string): FlexZone =>
  ({ id, name: id, routeId, bufferMiles: 0, geojson: { type: 'FeatureCollection', features: [] } }) as FlexZone;

beforeEach(() => {
  const x = s();
  x.setRoutes([]); x.setTrips([]); x.setCalendars([]); x.setCalendarDates([]);
  x.setFlexZones([]); x.setTimeframes([]); x.setStops([]);
});

describe('S1-14: refused calendar delete explains itself', () => {
  it('a referenced calendar is kept and the message names what uses it', () => {
    s().setCalendars([cal('WK')]);
    s().setTrips([trip('T1', 'R'), trip('T2', 'R')]);
    s().setFlexZones([zone('Z', undefined)]);
    s().updateFlexZone('Z', { serviceId: 'WK' });

    expect(s().removeCalendar('WK')).toBe(false);
    expect(s().calendars.map((c) => c.service_id)).toEqual(['WK']);
    const msg = calendarDeleteBlockedMessage(calendarReferences(s(), 'WK'));
    expect(msg).toContain('2 trips');
    expect(msg).toContain('1 flex zone');
    expect(msg).toMatch(/^Can't delete this calendar/);
  });

  it('an unreferenced calendar has no message and deletes', () => {
    s().setCalendars([cal('SPARE')]);
    expect(calendarDeleteBlockedMessage(calendarReferences(s(), 'SPARE'))).toBeNull();
    expect(s().removeCalendar('SPARE')).toBe(true);
  });

  it('lists every kind of reference', () => {
    expect(calendarDeleteBlockedMessage({ trips: 1, flexZones: 0, timeframes: 3, bookingRules: 1 }))
      .toBe("Can't delete this calendar: it is used by 1 trip, 1 flex booking rule and 3 fare timeframes. "
        + 'Move them to another calendar or delete them first.');
  });
});

describe('C3-03 / C4-15: signOutLocally', () => {
  it('empties the editor, forgets the server project and local drafts, then clears auth', async () => {
    const store = new Map<string, string>([[STAFF_IMPERSONATOR_KEY, 'staff-1']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    s().setRoutes([route('R')]);
    s().setTrips([trip('T', 'R')]);
    s().setProjectId('server-feed-1');
    useStore.setState((st) => { st.projectName = 'Previous user feed'; });
    s().setFeedsProjects([{ id: 'server-feed-1', slug: 'a' } as never], null);
    s().setActiveServerProject('server-feed-1');
    useStore.setState((st) => { st.currentUser = { id: 'u1' } as never; });
    const before = { ...cleared };

    await signOutLocally();

    expect(s().routes).toHaveLength(0);
    expect(s().trips).toHaveLength(0);
    expect(s().projectId).not.toBe('server-feed-1');
    expect(s().projectName).toBe('Untitled Feed');
    expect(s().isDirty).toBe(false);
    expect(s().feedsProjects).toHaveLength(0);
    expect(s().activeServerProjectId).toBeNull();
    expect(s().currentUser).toBeNull();
    expect(cleared.projects).toBe(before.projects + 1);
    expect(cleared.projectData).toBe(before.projectData + 1);
    expect(cleared.projectBulk).toBe(before.projectBulk + 1);
    expect(store.has(STAFF_IMPERSONATOR_KEY)).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('C3-04 / C3-27: left-rail badges', () => {
  it('counts a mixed fixed + flex route but not a flex-only one', () => {
    const state = {
      routes: [route('MIXED'), route('FLEXONLY'), route('FIXED')],
      trips: [trip('T1', 'MIXED'), trip('T2', 'FIXED')],
      flexZones: [zone('Z1', 'MIXED'), zone('Z2', 'FLEXONLY')],
    };
    expect(visibleRouteCount(state)).toBe(2);
  });

  it('counts Fares v2 products once per fare_product_id', () => {
    expect(fareCount({
      fareAttributes: [],
      fareProducts: [
        { fare_product_id: 'P1' }, { fare_product_id: 'P1' }, { fare_product_id: 'P2' },
      ],
    })).toBe(2);
    expect(fareCount({ fareAttributes: [{ fare_id: 'a' }], fareProducts: [] })).toBe(1);
  });
});

describe('C3-21: Discard & Reset', () => {
  it('goes to /editor, never the marketing root, with the store clean first', async () => {
    s().markDirty();
    let dirtyAtNavigation: boolean | null = null;
    const go = vi.fn((_url: string) => { dirtyAtNavigation = s().isDirty; });
    await discardAndStartFresh(go);
    expect(go).toHaveBeenCalledWith(freshEditorUrl());
    expect(freshEditorUrl('/')).toBe('/editor');
    expect(dirtyAtNavigation).toBe(false);
  });
});

describe('C3-23: bottom panel tab fallback', () => {
  it('a server-only tab without a server project shows the timetable', () => {
    expect(effectiveBottomTab('snapshots', false)).toBe('timetable');
    expect(effectiveBottomTab('audit', false)).toBe('timetable');
    expect(effectiveBottomTab('snapshots', true)).toBe('snapshots');
    expect(effectiveBottomTab('validation', false)).toBe('validation');
    expect(bottomPanelTabs(false)).not.toContain('publish');
  });
});

describe('C3-18: demo load after leaving /demo', () => {
  it('an aborted load never touches the store', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolveFetch = r; })));
    importMocks.importGtfsZip.mockResolvedValue({ routes: [] });
    importMocks.loadImportIntoStore.mockClear();
    useStore.setState((st) => { st.projectName = 'My feed'; });

    const controller = new AbortController();
    const done = loadDemoFeed(controller.signal);
    controller.abort();
    resolveFetch(new Response(new Blob(['zip'])));
    await done;

    expect(importMocks.loadImportIntoStore).not.toHaveBeenCalled();
    expect(s().projectName).toBe('My feed');
    vi.unstubAllGlobals();
  });

  it('a live load still applies the demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['zip']))));
    importMocks.importGtfsZip.mockResolvedValue({ routes: [] });
    importMocks.loadImportIntoStore.mockClear();
    await loadDemoFeed(new AbortController().signal);
    expect(importMocks.loadImportIntoStore).toHaveBeenCalledTimes(1);
    expect(s().projectName).toBe('Sunny Valley Transit');
    vi.unstubAllGlobals();
  });
});
