// Stops / stations editor fixes (bug review B6): C1-12 coordinate drafts,
// C1-13 parent candidates, C1-15 pathway endpoints, C1-21 numeric time order,
// C1-24 no nested button in the Stops list row, C1-16 batched delete-all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  isActivationKey,
  parentStationCandidates,
  parentStationRequired,
  parseCoordDraft,
} from '../stopFormHelpers';
import { compareGtfsTimes } from '../departureSort';
import { StopListRow } from '../StopListRow';
import { CoordInput } from '../CoordInput';
import { endpointOptions, pathwayEndpoints } from '../../stations/pathwayHelpers';
import type { Stop } from '../../../types/gtfs';

const here = dirname(fileURLToPath(import.meta.url));
const stop = (id: string, location_type: number, extra: Partial<Stop> = {}): Stop =>
  ({ stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111, location_type, wheelchair_boarding: 0, ...extra }) as Stop;

describe('C1-12: lat/lon drafts', () => {
  it('never yields 0 for a cleared or half-typed value', () => {
    for (const raw of ['', ' ', '-', '.', '-.', 'abc', '1e', '--1']) {
      expect(parseCoordDraft(raw, 'lon')).toBeNull();
    }
  });

  it('accepts a typed negative longitude and range-checks', () => {
    expect(parseCoordDraft('-111.05', 'lon')).toBe(-111.05);
    expect(parseCoordDraft('-1', 'lon')).toBe(-1);
    expect(parseCoordDraft('-111.', 'lon')).toBe(-111);
    expect(parseCoordDraft('181', 'lon')).toBeNull();
    expect(parseCoordDraft('91', 'lat')).toBeNull();
    expect(parseCoordDraft('-90', 'lat')).toBe(-90);
  });

  it('renders as a text field holding the stored value', () => {
    const html = renderToStaticMarkup(
      createElement(CoordInput, { value: -111.05, kind: 'lon', onCommit: () => {} }),
    );
    expect(html).toContain('type="text"');
    expect(html).toContain('value="-111.05"');
  });
});

describe('C1-13: parent_station candidates', () => {
  const all = [
    stop('STA', 1), stop('STB', 1),
    stop('P1', 0, { parent_station: 'STA' }), stop('P2', 0, { parent_station: 'STB' }),
    stop('E1', 2, { parent_station: 'STA' }),
    stop('BA', 4, { parent_station: 'P1' }),
  ];

  it('boarding areas are offered platforms only, same station first', () => {
    const opts = parentStationCandidates(all.find((s) => s.stop_id === 'BA')!, all);
    expect(opts.map((s) => s.stop_id)).toEqual(['P1', 'P2']);
  });

  it('stops and entrances are offered stations only; stations get none', () => {
    expect(parentStationCandidates(all.find((s) => s.stop_id === 'E1')!, all).map((s) => s.stop_id))
      .toEqual(['STA', 'STB']);
    expect(parentStationCandidates(all.find((s) => s.stop_id === 'P1')!, all).map((s) => s.stop_id))
      .toEqual(['STA', 'STB']);
    expect(parentStationCandidates(all[0], all)).toEqual([]);
  });

  it('keeps a current parent that no longer fits listed', () => {
    const odd = stop('X', 4, { parent_station: 'STA' });
    expect(parentStationCandidates(odd, [...all, odd]).map((s) => s.stop_id)).toContain('STA');
  });

  it('marks parent_station required for types 2/3/4 only', () => {
    expect([0, 1, 2, 3, 4].map(parentStationRequired)).toEqual([false, false, true, true, true]);
  });
});

describe('C1-15: pathway endpoints exclude stations', () => {
  const stops = [stop('STA', 1, { stop_name: 'Central' }), stop('P1', 0), stop('P2', 0), stop('N', 3)];

  it('offers no station option', () => {
    const eligible = pathwayEndpoints(stops);
    expect(eligible.map((s) => s.stop_id)).not.toContain('STA');
    expect(endpointOptions(eligible, stops, 'P1').map((o) => o.value)).toEqual(['N', 'P1', 'P2']);
  });

  it('a row already pointing at a station still shows it, flagged', () => {
    const opts = endpointOptions(pathwayEndpoints(stops), stops, 'STA');
    expect(opts[0]).toEqual({ value: 'STA', label: 'Central (station — not allowed)' });
  });
});

describe('C1-21: departures order by time value, not string', () => {
  it('9:00:00 comes before 10:00:00, overnight last', () => {
    const times = ['10:00:00', '25:30:00', '9:00:00', '08:05:00'];
    expect([...times].sort(compareGtfsTimes)).toEqual(['08:05:00', '9:00:00', '10:00:00', '25:30:00']);
  });
});

describe('C1-24: Stops list row', () => {
  it('has no button inside a button, and is keyboard-activatable', () => {
    const html = renderToStaticMarkup(createElement(StopListRow, {
      stop: stop('S1', 0), isHidden: false, onOpen: () => {}, onToggleVisibility: () => {},
    }));
    expect(html).toMatch(/^<div role="button" tabindex="0"/);
    expect((html.match(/<button/g) || []).length).toBe(1);
    expect(isActivationKey('Enter')).toBe(true);
    expect(isActivationKey(' ')).toBe(true);
    expect(isActivationKey('a')).toBe(false);
  });
});

describe('C1-16: delete-all-shown is one batched removal', () => {
  it('StopList calls removeStops once instead of looping removeStop', () => {
    const text = readFileSync(join(here, '..', 'StopList.tsx'), 'utf8');
    expect(text).toContain('removeStops(sortedStops.map((s) => s.stop_id))');
    expect(text).not.toMatch(/\bremoveStop\(/);
  });
});
