// @vitest-environment jsdom
// Rendered ImportDialog tests.
//   C3-01  Cancel while a zip is still parsing: when the parse resolves later
//          the current project is NOT replaced and nothing is persisted.
//   C3-02  A project with stops (or calendars) but no routes is not "empty":
//          importing shows the options screen instead of silently replacing.
// The session primitive and storeHasAnyFeedContent are pinned in
// importGuards.test.ts; these pin the dialog's use of them. The parser and the
// store loaders are mocked at the gtfsImport module boundary.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { resetStore, store } from '../../../test-utils/store';
import type { Route, Stop } from '../../../types/gtfs';

const io = vi.hoisted(() => ({
  parse: null as null | { resolve: (d: unknown) => void },
  loadImportIntoStore: vi.fn(),
  mergeImportIntoStore: vi.fn(),
  persistImportedFeed: vi.fn(async () => ({ kind: 'local' as const })),
}));
vi.mock('../../../services/gtfsImport', () => ({
  inspectGtfsZip: async () => ({ isLarge: false }),
  parseGtfsInWorker: () => new Promise((resolve) => { io.parse = { resolve }; }),
  loadImportIntoStore: io.loadImportIntoStore,
  mergeImportIntoStore: io.mergeImportIntoStore,
}));
vi.mock('../../../services/importPersist', () => ({ persistImportedFeed: io.persistImportedFeed }));

import { ImportDialog } from '../ImportDialog';

const route = (id: string): Route => ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const stop = (id: string): Stop => ({ stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111, location_type: 0 }) as Stop;
const parsed = {
  routes: [route('NEW1'), route('NEW2')], stops: [stop('NS')], trips: [], shapes: [], warnings: [],
  agencies: [], calendars: [], calendarDates: [], stopTimes: [], routeStops: [],
};

/** Mounts the dialog the way MyFeedsPage / the TopBar do: closing unmounts it. */
function Host() {
  const [open, setOpen] = useState(true);
  return open ? <ImportDialog onClose={() => setOpen(false)} /> : <div>dialog closed</div>;
}

async function chooseZip(user: ReturnType<typeof userEvent.setup>) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(input, new File(['zip'], 'feed.zip', { type: 'application/zip' }));
  await vi.waitFor(() => expect(io.parse).not.toBeNull());
}

beforeEach(() => {
  io.parse = null;
  io.loadImportIntoStore.mockClear();
  io.mergeImportIntoStore.mockClear();
  io.persistImportedFeed.mockClear();
});

describe('ImportDialog cancel mid-parse (C3-01)', () => {
  // An empty project is the dangerous case: a resolved parse goes straight to
  // replace-and-persist without an options screen in between.
  beforeEach(() => resetStore({ projectName: 'My feed' }));

  it('a parse that resolves after Cancel never replaces the project', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await chooseZip(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('dialog closed')).toBeInTheDocument();

    await act(async () => { io.parse!.resolve(parsed); });

    expect(io.loadImportIntoStore).not.toHaveBeenCalled();
    expect(io.persistImportedFeed).not.toHaveBeenCalled();
    expect(store().projectName).toBe('My feed');
  });

  it('the same parse with the dialog still open does replace the empty project', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await chooseZip(user);
    await act(async () => { io.parse!.resolve(parsed); });
    expect(io.loadImportIntoStore).toHaveBeenCalledTimes(1);
    expect(io.persistImportedFeed).toHaveBeenCalledTimes(1);
    expect(store().projectName).toBe('feed');
  });
});

describe('ImportDialog on a project with content but no routes (C3-02)', () => {
  it.each([
    ['stops only', { stops: [stop('S1')] }],
    ['a calendar only', {
      calendars: [{
        service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
        saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
      }],
    }],
  ])('%s: shows the options screen instead of auto-replacing', async (_label, seed) => {
    resetStore(seed as never);
    const user = userEvent.setup();
    render(<Host />);
    await chooseZip(user);
    await act(async () => { io.parse!.resolve(parsed); });

    expect(io.loadImportIntoStore).not.toHaveBeenCalled();
    expect(screen.getByText('Import Options')).toBeInTheDocument();
    // Merge is offered into a project with content, and Replace warns first.
    expect(screen.getByRole('button', { name: 'Import selected routes' })).toBeEnabled();
    expect(screen.getByText(/Replacing discards everything in the current project/)).toBeInTheDocument();
  });
});
