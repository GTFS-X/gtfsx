// Pure helpers for ImportDialog's cancel guard (C3-01) and its "is this
// project empty?" shortcut (C3-02). Kept out of the component so they can be
// unit-tested without a DOM.
import type { AppStore } from '../../store';

/** Thrown (and swallowed by the dialog) when the dialog was closed while an
 * import step was in flight. Never shown to the user. */
export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

/** One open lifetime of the Import dialog. Closing it aborts in-flight fetches
 * and makes every later `checkpoint` throw, so a parse or download that
 * resolves after Cancel never touches the store or the server. */
export interface ImportSession {
  readonly closed: boolean;
  readonly signal: AbortSignal;
  close(): void;
}

export function createImportSession(): ImportSession {
  const controller = new AbortController();
  let closed = false;
  return {
    get closed() { return closed; },
    signal: controller.signal,
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}

/** Await `p`, then throw ImportCancelled if the session closed meanwhile.
 * Also maps an abort of the session's own signal to ImportCancelled. */
export async function checkpoint<T>(session: ImportSession, p: Promise<T>): Promise<T> {
  let value: T;
  try {
    value = await p;
  } catch (e) {
    if (session.closed) throw new ImportCancelled();
    throw e;
  }
  if (session.closed) throw new ImportCancelled();
  return value;
}

export function isImportCancelled(e: unknown): e is ImportCancelled {
  return e instanceof ImportCancelled;
}

/** A fetch bound to the session's abort signal (for helpers that take a
 * `fetchImpl`, such as the catalog download). */
export function sessionFetch(session: ImportSession): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: session.signal });
}

type FeedContentState = Pick<
  AppStore,
  | 'agencies' | 'routes' | 'stops' | 'trips' | 'calendars' | 'calendarDates'
  | 'fareAttributes' | 'fareProducts' | 'fareLegRules' | 'flexZones' | 'shapes' | 'translations'
>;

/**
 * True when the open project holds anything a wholesale replace would destroy.
 *
 * The import dialog used to treat "no routes" as "empty project" and replace
 * (and, for a cloud feed, overwrite on the server) a feed that had stops,
 * calendars or fares but no routes yet. Not serverPersistence's
 * `storeHasFeedContent`, which is deliberately routes/stops/trips only. An
 * agency only counts when it has a name: a fresh project carries a blank
 * default agency.
 */
export function storeHasAnyFeedContent(state: FeedContentState): boolean {
  return (
    state.routes.length > 0 ||
    state.stops.length > 0 ||
    state.trips.length > 0 ||
    state.calendars.length > 0 ||
    state.calendarDates.length > 0 ||
    state.fareAttributes.length > 0 ||
    state.fareProducts.length > 0 ||
    state.fareLegRules.length > 0 ||
    state.flexZones.length > 0 ||
    state.shapes.length > 0 ||
    state.translations.length > 0 ||
    state.agencies.some((a) => (a.agency_name ?? '').trim() !== '')
  );
}
