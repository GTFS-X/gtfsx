// E2E E4: clearing the frequency drawer's "Every N min" field silently became
// a 1-minute headway (`Math.max(1, Number(v) || 0)`), the departure count
// jumped to 181, and Apply stayed enabled, writing headway_secs=60.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkFrequencyDrawer, headwayMinutesInput, parseHeadwayMinutes } from '../timetableGridHelpers';

const win = (headway_secs: number) => ({ start_time: '06:00', end_time: '09:00', headway_secs, exact_times: 0 as const });

describe('frequency drawer headway field', () => {
  it('a cleared or invalid field parses to 0, not 60 seconds', () => {
    expect(parseHeadwayMinutes('')).toBe(0);
    expect(parseHeadwayMinutes('  ')).toBe(0);
    expect(parseHeadwayMinutes('0')).toBe(0);
    expect(parseHeadwayMinutes('-5')).toBe(0);
    expect(parseHeadwayMinutes('15')).toBe(900);
  });

  it('shows blank for an unset headway instead of 1', () => {
    expect(headwayMinutesInput(0)).toBe('');
    expect(headwayMinutesInput(900)).toBe(15);
  });

  it('a cleared field blocks Apply', () => {
    const check = checkFrequencyDrawer([win(parseHeadwayMinutes(''))]);
    expect(check.errors[0].badHeadway).toBe(true);
    expect(check.canApply).toBe(false);
    expect(checkFrequencyDrawer([win(900)]).canApply).toBe(true);
  });

  it('the drawer uses the helpers rather than clamping to 1', () => {
    const src = readFileSync(fileURLToPath(new URL('../TimetableDrawers.tsx', import.meta.url)), 'utf8');
    const i = src.indexOf('export function FrequencyDrawer');
    const drawer = src.slice(i);
    expect(drawer).toMatch(/value=\{headwayMinutesInput\(w\.headway_secs\)\}/);
    expect(drawer).toMatch(/headway_secs: parseHeadwayMinutes\(e\.target\.value\)/);
    expect(drawer).not.toMatch(/headway_secs: Math\.max\(1,/);
  });
});
