// The store keys that constitute PERSISTED FEED STATE — the single definition
// of "did the user change something that needs saving?".
//
// Deliberately a leaf module with no imports: it is read by the store's own
// middleware (historyMiddleware) AND by the persistence layer
// (db/persistence.ts), and a shared list is the only thing that keeps the
// dirty-tracking, the IndexedDB snapshot, and the server snapshot from
// drifting apart.

// The heavy tables — millions of rows for a regional feed. Persisted in their
// own IndexedDB record and only rewritten when they actually change.
export const BULK_KEYS = ['stopTimes', 'shapes'] as const;

// Everything else — small enough to snapshot on every autosave.
export const SMALL_KEYS = [
  'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops',
  'stops', 'trips', 'feedInfo',
  'fareAttributes', 'fareRules',
  'fareAreas', 'stopAreas', 'fareNetworks', 'routeNetworks',
  'timeframes', 'riderCategories', 'fareMedia',
  'fareProducts', 'fareLegRules', 'fareTransferRules',
  'frequencies', 'levels', 'pathways',
  // GTFS-Flex demand-response service areas. Must be persisted alongside their
  // paired routes/stops; the server-backed path (serverPersistence.ts) already
  // saves these, so the IndexedDB cache has to match or anonymous drafts lose
  // every flex zone (geometry, name, booking rules) on reload.
  'flexZones',
  // transfers.txt — same story: the exporter writes it but it was never cached,
  // so an anonymous draft's transfers vanished on reload (#67).
  'transfers',
  'featureSettings',
  'dismissedValidations',
  'projectId', 'projectName',
  'licenseSpdx',
  // Mobility Database import provenance (issue #47). Cached locally alongside
  // licenseSpdx so an anonymous draft imported from MDB still carries its
  // source id after a reload and through the sign-in → server-migration flow.
  'mdbSourceId',
] as const;

/**
 * Union used for "did any persisted data change?" detection.
 *
 * The store middleware compares these keys BY REFERENCE across every `set` and
 * flips `isDirty` when one moves. Immer replaces the array/object it touched,
 * so identity is a reliable change signal and the check costs ~33 pointer
 * comparisons per mutation.
 */
export const DATA_KEYS = [...SMALL_KEYS, ...BULK_KEYS] as const;

export type PersistedKey = (typeof DATA_KEYS)[number];
