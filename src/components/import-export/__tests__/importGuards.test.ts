// ImportDialog guards:
// - C3-01: a parse/download that resolves after the dialog closed must never
//   reach the store (or the server persist that follows a replace).
// - C3-02: "empty project" means no feed content at all, not just no routes.
// - C3-22: the deep-link error panel links to the static docs with a plain <a>.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStore } from '../../../store';
import { loadImportIntoStore, type ImportData } from '../../../services/gtfsImport';
import {
  checkpoint, createImportSession, isImportCancelled, storeHasAnyFeedContent, ImportCancelled,
} from '../importGuards';
import { ErrorPanel } from '../DeepLinkImportPage';

const s = () => useStore.getState();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const feed = {
  agencies: [{ agency_id: 'A', agency_name: 'Imported', agency_url: 'https://x', agency_timezone: 'UTC' }],
  routes: [{ route_id: 'R1', route_type: 3, route_short_name: '1' }],
  stops: [], trips: [], stopTimes: [], calendars: [], calendarDates: [], shapes: [],
  warnings: [],
} as unknown as ImportData;

beforeEach(() => {
  s().setRoutes([]);
  s().setStops([]);
  s().setCalendars([]);
  s().setAgencies([]);
});

describe('import session (C3-01)', () => {
  it('a parse that resolves after Cancel never reaches the store', async () => {
    const session = createImportSession();
    const parse = deferred<ImportData>();
    const present = vi.fn((data: ImportData) => loadImportIntoStore(data));

    // The dialog's step: await the parse through the session, then present.
    const step = (async () => {
      try {
        present(await checkpoint(session, parse.promise));
      } catch (e) {
        if (!isImportCancelled(e)) throw e;
      }
    })();

    session.close(); // user clicks Cancel mid-parse
    parse.resolve(feed);
    await step;

    expect(present).not.toHaveBeenCalled();
    expect(s().routes).toHaveLength(0);
  });

  it('closing aborts the session signal, and an aborted fetch maps to ImportCancelled', async () => {
    const session = createImportSession();
    const fetchLike = deferred<Response>();
    const p = checkpoint(session, fetchLike.promise);
    session.close();
    expect(session.signal.aborted).toBe(true);
    fetchLike.reject(new DOMException('aborted', 'AbortError'));
    await expect(p).rejects.toBeInstanceOf(ImportCancelled);
  });

  it('passes values and real errors through while open', async () => {
    const session = createImportSession();
    await expect(checkpoint(session, Promise.resolve(7))).resolves.toBe(7);
    await expect(checkpoint(session, Promise.reject(new Error('bad zip')))).rejects.toThrow('bad zip');
  });
});

describe('storeHasAnyFeedContent (C3-02)', () => {
  it('is false for a fresh project (even with a blank default agency)', () => {
    expect(storeHasAnyFeedContent(s())).toBe(false);
    s().setAgencies([{ agency_id: '', agency_name: '', agency_url: '', agency_timezone: '' } as never]);
    expect(storeHasAnyFeedContent(s())).toBe(false);
  });

  it('is true for a stops-and-calendar feed with no routes', () => {
    s().setStops([{ stop_id: 'S1', stop_name: 'Main', stop_lat: 45, stop_lon: -111 } as never]);
    s().setCalendars([{
      service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
      saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
    } as never]);
    expect(storeHasAnyFeedContent(s())).toBe(true);
  });

  it('counts a named agency on its own', () => {
    s().setAgencies([{ agency_id: 'A', agency_name: 'Valley Transit', agency_url: '', agency_timezone: '' } as never]);
    expect(storeHasAnyFeedContent(s())).toBe(true);
  });
});

describe('DeepLinkImportPage ErrorPanel (C3-22)', () => {
  it('links to the static docs with a plain anchor', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorPanel, { error: { code: 'fetch_failed', message: 'nope' }, onUploadFallback: () => {} }),
    );
    expect(html).toContain('href="/docs/deep-links/"');
  });
});
