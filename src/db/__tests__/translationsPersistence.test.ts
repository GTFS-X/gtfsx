// translations.txt persistence: IndexedDB (Dexie) autosave/reload — including
// drafts cached before translations existed — and the server working-state
// snapshot, which also feeds versions and variants.
//
// Dexie schema note: no version bump is needed. The `projectData` store keeps
// the whole small-table snapshot as one structured object, and Dexie's
// .stores() only declares keys/indexes, so a new `translations` key inside that
// object needs no IndexedDB migration. What DOES need covering is the load
// path: an existing v1 (JSON string) or v2 (object) row with no `translations`
// key must load as "no translations", never as the previous feed's.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Translation } from '../../types/gtfs';

// In-memory stand-in for the three Dexie tables persistence.ts touches.
const tables = vi.hoisted(() => {
  const mk = <K extends string>(key: K) => {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      rows,
      put: async (r: Record<string, unknown>) => { rows.set(String(r[key]), structuredClone(r)); },
      get: async (id: string) => (rows.has(id) ? structuredClone(rows.get(id)) : undefined),
      toArray: async () => [...rows.values()],
      where: (field: string) => ({
        notEqual: (value: unknown) => ({
          delete: async () => {
            for (const [id, r] of rows) if (r[field] !== value) rows.delete(id);
          },
        }),
      }),
    };
  };
  return { projects: mk('id'), projectData: mk('projectId'), projectBulk: mk('projectId') };
});
vi.mock('../dexie', () => ({
  db: {
    ...tables,
    // Dexie's db.transaction(mode, ...tables, scope): just run the scope.
    transaction: async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
  },
}));

const { useStore } = await import('../../store');
const { saveProject, loadProject } = await import('../persistence');
const { buildSnapshot, applySnapshotToStore, resetEditorState, buildWorkingStateSnapshot } = await import('../serverPersistence');

const ROWS: Translation[] = [
  { table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Calle Mayor', record_id: 'S1' },
  { table_name: 'trips', field_name: 'trip_headsign', language: 'es', translation: 'Hacia el norte', field_value: 'Northbound' },
];

beforeEach(() => {
  tables.projects.rows.clear();
  tables.projectData.rows.clear();
  tables.projectBulk.rows.clear();
  resetEditorState();
});

describe('IndexedDB (Dexie) autosave', () => {
  it('saves translations in the small-table snapshot and reloads them', async () => {
    useStore.getState().setProjectId('p1');
    useStore.getState().setTranslations(ROWS);
    await saveProject();
    expect((tables.projectData.rows.get('p1')!.storeSnapshot as Record<string, unknown>).translations).toEqual(ROWS);

    resetEditorState();
    expect(useStore.getState().translations).toEqual([]);
    expect(await loadProject('p1')).toBe(true);
    expect(useStore.getState().translations).toEqual(ROWS);
  });

  it('a v2 row cached before translations existed loads with none (no cross-feed leak)', async () => {
    await tables.projectData.put({ projectId: 'old', storeSnapshot: { routes: [], stops: [], projectName: 'Old' } });
    useStore.getState().setTranslations(ROWS); // feed A, still in memory
    expect(await loadProject('old')).toBe(true);
    expect(useStore.getState().translations).toEqual([]);
  });

  it('a legacy v1 row (JSON string snapshot) loads too, with or without translations', async () => {
    await tables.projectData.put({ projectId: 'v1', storeSnapshot: JSON.stringify({ routes: [], stopTimes: [], shapes: [] }) });
    useStore.getState().setTranslations(ROWS);
    expect(await loadProject('v1')).toBe(true);
    expect(useStore.getState().translations).toEqual([]);

    await tables.projectData.put({ projectId: 'v1b', storeSnapshot: JSON.stringify({ routes: [], translations: ROWS }) });
    expect(await loadProject('v1b')).toBe(true);
    expect(useStore.getState().translations).toEqual(ROWS);
  });
});

describe('server working-state snapshot', () => {
  it('buildSnapshot carries translations and applySnapshotToStore restores them', () => {
    useStore.getState().setTranslations(ROWS);
    const wire = JSON.parse(JSON.stringify(buildSnapshot()));
    expect(wire.translations).toEqual(ROWS);
    resetEditorState();
    applySnapshotToStore(wire);
    expect(useStore.getState().translations).toEqual(ROWS);
  });

  it('an older server snapshot without the key loads clean', () => {
    useStore.getState().setTranslations(ROWS);
    applySnapshotToStore({ routes: [], stops: [] });
    expect(useStore.getState().translations).toEqual([]);
  });

  it('the version/variant snapshot (buildWorkingStateSnapshot) includes translations', () => {
    useStore.getState().setTranslations(ROWS);
    const snap = buildWorkingStateSnapshot() as Record<string, unknown>;
    expect(snap.translations).toEqual(ROWS);
  });

  it('marks the project dirty when a translation is edited', () => {
    useStore.getState().markSaved();
    expect(useStore.getState().isDirty).toBe(false);
    useStore.getState().addTranslation(ROWS[0]);
    expect(useStore.getState().isDirty).toBe(true);
  });
});
