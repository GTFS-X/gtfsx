// S1-23: the anonymous-draft IndexedDB autosave is never read back on reload
// and the store mints a fresh projectId per page load, so every visit used to
// leave a full copy of its feed behind. saveProject now keeps only the current
// project's rows.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tables = vi.hoisted(() => {
  const mk = (key: string) => {
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
const transaction = vi.hoisted(() => vi.fn());
vi.mock('../dexie', () => ({ db: { ...tables, transaction } }));

const { useStore } = await import('../../store');
const { saveProject } = await import('../persistence');

beforeEach(() => {
  for (const t of Object.values(tables)) t.rows.clear();
  transaction.mockReset();
  transaction.mockImplementation(async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)());
});

describe('saveProject prunes other drafts', () => {
  it('two saves under different projectIds leave exactly one row per table', async () => {
    useStore.getState().setProjectId('draft-1');
    await saveProject();
    useStore.getState().setProjectId('draft-2');
    await saveProject();

    for (const t of Object.values(tables)) {
      expect([...t.rows.keys()]).toEqual(['draft-2']);
    }
  });

  it('does the write and the prune in one read-write transaction over all three tables', async () => {
    useStore.getState().setProjectId('draft-3');
    await saveProject();
    expect(transaction).toHaveBeenCalledTimes(1);
    const [mode, ...rest] = transaction.mock.calls[0];
    expect(mode).toBe('rw');
    expect(rest.slice(0, 3)).toEqual([tables.projects, tables.projectData, tables.projectBulk]);
  });
});
