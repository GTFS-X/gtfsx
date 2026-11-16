// Passthrough-file persistence: IndexedDB (Dexie) autosave/reload — including
// drafts cached before the key existed — the server working-state snapshot
// (cloud save, which also backs snapshots), variants, and the transient
// snapshot swap that renders publish / draft-link / rollback ZIPs.
//
// Dexie: no schema bump. `projectData` keeps the small-table snapshot as one
// structured object; a new key inside it needs no IndexedDB migration.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { PassthroughFile } from '../../services/feedPassthrough';
import { encodePassthroughFile } from '../../services/feedPassthrough';

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
    transaction: async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
  },
}));

const { useStore } = await import('../../store');
const { saveProject, loadProject } = await import('../persistence');
const {
  buildSnapshot, applySnapshotToStore, resetEditorState, buildWorkingStateSnapshot, withTransientSnapshot,
} = await import('../serverPersistence');
const { exportGtfsZip } = await import('../../services/gtfsExport');
const { buildVariantsEnvelope, parseVariantsEnvelope } = await import('../../services/variantPersistence');

const FILES: PassthroughFile[] = [
  encodePassthroughFile('calendar_attributes.txt', new TextEncoder().encode('service_id,service_description\nWK,Weekdays\n')),
  encodePassthroughFile('logo.bin', new Uint8Array([0xff, 0x00, 0xfe, 0x80])),
];

beforeEach(() => {
  tables.projects.rows.clear();
  tables.projectData.rows.clear();
  tables.projectBulk.rows.clear();
  resetEditorState();
});

describe('IndexedDB (Dexie) autosave', () => {
  it('saves passthrough files in the small-table snapshot and reloads them', async () => {
    useStore.getState().setProjectId('p1');
    useStore.getState().setPassthroughFiles(FILES);
    await saveProject();
    expect((tables.projectData.rows.get('p1')!.storeSnapshot as Record<string, unknown>).passthroughFiles).toEqual(FILES);
    resetEditorState();
    expect(useStore.getState().passthroughFiles).toEqual([]);
    expect(await loadProject('p1')).toBe(true);
    expect(useStore.getState().passthroughFiles).toEqual(FILES);
  });

  it('a draft cached before passthrough files existed loads with none (no cross-feed leak)', async () => {
    await tables.projectData.put({ projectId: 'old', storeSnapshot: { routes: [], stops: [], projectName: 'Old' } });
    useStore.getState().setPassthroughFiles(FILES);
    expect(await loadProject('old')).toBe(true);
    expect(useStore.getState().passthroughFiles).toEqual([]);

    await tables.projectData.put({ projectId: 'v1', storeSnapshot: JSON.stringify({ routes: [], stopTimes: [], shapes: [] }) });
    useStore.getState().setPassthroughFiles(FILES);
    expect(await loadProject('v1')).toBe(true);
    expect(useStore.getState().passthroughFiles).toEqual([]);
  });
});

describe('server working-state snapshot (cloud save)', () => {
  it('survives the JSON wire round trip', () => {
    useStore.getState().setPassthroughFiles(FILES);
    const wire = JSON.parse(JSON.stringify(buildWorkingStateSnapshot()));
    expect(wire.passthroughFiles).toEqual(FILES);
    resetEditorState();
    applySnapshotToStore(wire);
    expect(useStore.getState().passthroughFiles).toEqual(FILES);
  });

  it('an older server snapshot without the key loads clean', () => {
    useStore.getState().setPassthroughFiles(FILES);
    applySnapshotToStore({ routes: [], stops: [] });
    expect(useStore.getState().passthroughFiles).toEqual([]);
  });

  it('variants inherit them from the baseline through the envelope', () => {
    useStore.getState().setPassthroughFiles(FILES);
    const base = buildSnapshot();
    const variant = { ...base, routes: [] };
    const env = buildVariantsEnvelope(
      [
        { id: 'b', name: 'Baseline', baseline: true, createdAt: 1, modifiedAt: 1, snapshot: base },
        { id: 'v', name: 'Alt', baseline: false, createdAt: 2, modifiedAt: 2, snapshot: variant },
      ],
      'v',
      base,
    );
    const wire = JSON.parse(JSON.stringify({ ...base, __variants: env }));
    const parsed = parseVariantsEnvelope(wire, wire)!;
    expect(parsed.variants.find((v) => v.id === 'v')!.snapshot.passthroughFiles).toEqual(FILES);
  });

  it('a past snapshot rendered to a ZIP (publish / draft link / rollback) includes its files', async () => {
    useStore.getState().setPassthroughFiles([]);
    const past = { ...buildSnapshot(), passthroughFiles: FILES };
    const blob = await withTransientSnapshot(past, () => exportGtfsZip());
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
    expect(await zip.file('logo.bin')!.async('uint8array')).toEqual(new Uint8Array([0xff, 0x00, 0xfe, 0x80]));
    expect(zip.file('calendar_attributes.txt')).not.toBeNull();
    expect(useStore.getState().passthroughFiles).toEqual([]); // live store restored
  });
});
