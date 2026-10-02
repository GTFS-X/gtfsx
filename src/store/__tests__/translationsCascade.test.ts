// translations.txt referential integrity: renaming or deleting a referenced
// record updates or removes its translations, the same way the other child
// references (stop_times, route_stops, transfers, fare rules) are handled.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { resetEditorState } from '../../db/serverPersistence';
import { undo, resetHistory } from '../history';
import type { Translation } from '../../types/gtfs';

const s = () => useStore.getState();
const tr = (t: Partial<Translation>): Translation => ({
  table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'x', ...t,
});

function seed() {
  resetEditorState();
  const st = s();
  st.setAgencies([
    { agency_id: 'A', agency_name: 'Alpha', agency_url: 'https://a.test', agency_timezone: 'America/Denver' },
    { agency_id: 'B', agency_name: 'Beta', agency_url: 'https://b.test', agency_timezone: 'America/Denver' },
  ]);
  st.setStops([
    { stop_id: 'S1', stop_name: 'One', stop_lat: 45, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'S2', stop_name: 'Two', stop_lat: 45.01, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'S3', stop_name: 'Three', stop_lat: 45.02, stop_lon: -111, location_type: 0, wheelchair_boarding: 0 },
  ]);
  st.setRoutes([
    { route_id: 'R1', agency_id: 'A', route_short_name: '1', route_long_name: 'One', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' },
    { route_id: 'R2', agency_id: 'A', route_short_name: '2', route_long_name: 'Two', route_type: 3, route_color: '000000', route_text_color: 'FFFFFF' },
  ]);
  st.setRouteStops([
    { route_id: 'R1', stop_id: 'S1', direction_id: 0, stop_sequence: 0, _snapped: true, _uid: 'u1' },
    { route_id: 'R1', stop_id: 'S2', direction_id: 0, stop_sequence: 1, _snapped: true, _uid: 'u2' },
    { route_id: 'R2', stop_id: 'S2', direction_id: 0, stop_sequence: 0, _snapped: true, _uid: 'u3' },
    { route_id: 'R2', stop_id: 'S3', direction_id: 0, stop_sequence: 1, _snapped: true, _uid: 'u4' },
  ]);
  st.setTrips([
    { trip_id: 'T1', route_id: 'R1', service_id: 'WK', direction_id: 0, trip_headsign: 'North' },
    { trip_id: 'T2', route_id: 'R2', service_id: 'WK', direction_id: 0, trip_headsign: 'South' },
  ]);
  st.setStopTimes([
    { trip_id: 'T1', stop_id: 'S1', stop_sequence: 0, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'T1', stop_id: 'S2', stop_sequence: 1, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'T2', stop_id: 'S2', stop_sequence: 0, arrival_time: '09:00:00', departure_time: '09:00:00' },
  ]);
  st.setLevels([{ level_id: 'L0', level_index: 0, level_name: 'Ground' }]);
  st.setPathways([{ pathway_id: 'P1', from_stop_id: 'S1', to_stop_id: 'S2', pathway_mode: 1, is_bidirectional: 1 }]);
  st.setTranslations([
    tr({ table_name: 'agency', field_name: 'agency_name', record_id: 'A' }),
    tr({ table_name: 'agency', field_name: 'agency_name', record_id: 'B' }),
    tr({ record_id: 'S1' }),
    tr({ record_id: 'S2' }),
    tr({ record_id: 'S3' }),
    tr({ table_name: 'routes', field_name: 'route_long_name', record_id: 'R1' }),
    tr({ table_name: 'routes', field_name: 'route_long_name', record_id: 'R2' }),
    tr({ table_name: 'trips', field_name: 'trip_headsign', record_id: 'T1' }),
    tr({ table_name: 'stop_times', field_name: 'stop_headsign', record_id: 'T1', record_sub_id: '1' }),
    tr({ table_name: 'trips', field_name: 'trip_headsign', record_id: 'T2' }),
    tr({ table_name: 'trips', field_name: 'trip_headsign', field_value: 'North' }), // by value
    tr({ table_name: 'levels', field_name: 'level_name', record_id: 'L0' }),
    tr({ table_name: 'pathways', field_name: 'signposted_as', record_id: 'P1' }),
  ]);
  resetHistory();
}

const refs = () => s().translations.map((t) => `${t.table_name}:${t.record_id ?? `=${t.field_value}`}${t.record_sub_id ? `#${t.record_sub_id}` : ''}`);

beforeEach(seed);

describe('renames', () => {
  it('renaming an agency_id re-points its translations', () => {
    s().renameAgencyIdAt(0, 'ALPHA');
    expect(refs()).toContain('agency:ALPHA');
    expect(refs()).not.toContain('agency:A');
    expect(refs()).toContain('agency:B');
  });

  it('renaming a trip re-points trip and stop_times translations, not by-value ones', () => {
    s().renameTripId('T1', 'T1-new');
    expect(refs()).toEqual(expect.arrayContaining(['trips:T1-new', 'stop_times:T1-new#1', 'trips:=North']));
    expect(refs()).not.toContain('trips:T1');
  });

  it('editing a level_id or pathway_id carries its translations along', () => {
    s().updateLevel(0, { level_id: 'L-ground' });
    s().updatePathway(0, { pathway_id: 'P-exit' });
    expect(refs()).toEqual(expect.arrayContaining(['levels:L-ground', 'pathways:P-exit']));
  });

  it('an undo of the rename restores the old reference', () => {
    s().renameTripId('T1', 'T1-new');
    undo();
    expect(refs()).toContain('trips:T1');
    expect(refs()).toContain('stop_times:T1#1');
  });
});

describe('deletes', () => {
  it('deleting a stop drops its translations', () => {
    s().removeStop('S3');
    expect(refs()).not.toContain('stops:S3');
    expect(refs()).toContain('stops:S1');
  });

  it('removeStopWithSnapshot → restoreStop brings the translations back', () => {
    const snap = s().removeStopWithSnapshot('S1');
    expect(snap.translations).toHaveLength(1);
    expect(refs()).not.toContain('stops:S1');
    s().restoreStop(snap);
    expect(refs()).toContain('stops:S1');
  });

  it('deleting a trip drops its trip + stop_times translations (and undo restores them)', () => {
    const snap = s().removeTripWithSnapshot('T1');
    expect(refs()).not.toContain('trips:T1');
    expect(refs()).not.toContain('stop_times:T1#1');
    expect(refs()).toContain('trips:=North'); // a value, not a record
    s().restoreTrip(snap);
    expect(refs()).toEqual(expect.arrayContaining(['trips:T1', 'stop_times:T1#1']));

    s().removeTrip('T2');
    expect(refs()).not.toContain('trips:T2');
  });

  it("deleting a route drops the route's, its trips' and its orphaned stops' translations", () => {
    s().removeRoute('R1'); // S1 is unique to R1; S2 is shared with R2
    expect(refs()).not.toContain('routes:R1');
    expect(refs()).not.toContain('trips:T1');
    expect(refs()).not.toContain('stop_times:T1#1');
    expect(refs()).not.toContain('stops:S1');
    expect(refs()).toEqual(expect.arrayContaining(['routes:R2', 'trips:T2', 'stops:S2', 'stops:S3']));
  });

  it('a route delete that keeps its stops keeps their translations', () => {
    s().removeRoute('R1', { deleteOrphanedStops: false });
    expect(refs()).toContain('stops:S1');
  });

  it('deleting an agency, level or pathway drops their translations', () => {
    s().removeAgencyAt(1);
    s().removeLevel(0);
    s().removePathway(0);
    expect(refs()).not.toContain('agency:B');
    expect(refs()).not.toContain('levels:L0');
    expect(refs()).not.toContain('pathways:P1');
    expect(refs()).toContain('agency:A');
  });

  it('a route delete is one undo step, translations included', () => {
    const before = s().translations;
    s().removeRoute('R1');
    undo();
    expect(s().translations).toEqual(before);
  });
});

describe('slice actions', () => {
  it('upsertTranslation updates in place, appends new keys, and deletes on empty', () => {
    const key = { table_name: 'stops', field_name: 'stop_name', language: 'fr', record_id: 'S1' };
    s().upsertTranslation({ ...key, translation: 'Un' });
    const n = s().translations.length;
    s().upsertTranslation({ ...key, translation: 'Une' });
    expect(s().translations).toHaveLength(n);
    expect(s().translations.at(-1)!.translation).toBe('Une');
    s().upsertTranslation({ ...key, translation: '' });
    expect(s().translations).toHaveLength(n - 1);
  });

  it('updateTranslationAt drops cleared optional keys rather than storing ""', () => {
    s().updateTranslationAt(2, { record_id: '', field_value: 'One' });
    const row = s().translations[2];
    expect('record_id' in row).toBe(false);
    expect(row.field_value).toBe('One');
  });
});
