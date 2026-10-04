// S1-24: the feed-data key lists must not drift. The server snapshot is every
// persisted key except project metadata, and everything undoable is persisted.
import { describe, expect, it } from 'vitest';
import { DATA_KEYS } from '../../store/persistedKeys';
import { HISTORY_KEYS } from '../../store/history';
import { SERVER_DATA_KEYS, buildSnapshot } from '../serverPersistence';

describe('persisted key lists', () => {
  it('server snapshot keys = persisted keys minus projectId/projectName', () => {
    const expected = DATA_KEYS.filter((k) => k !== 'projectId' && k !== 'projectName');
    expect([...SERVER_DATA_KEYS].sort()).toEqual([...expected].sort());
    expect(Object.keys(buildSnapshot()).sort()).toEqual([...expected].sort());
  });

  it('every undoable key is persisted', () => {
    const persisted = new Set<string>(DATA_KEYS);
    expect([...HISTORY_KEYS].filter((k) => !persisted.has(k))).toEqual([]);
  });
});
