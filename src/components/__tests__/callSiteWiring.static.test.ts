// Source-text pins for fix call sites that are impractical to drive through a
// rendered test (signOutCallers.test.ts style). Everything that CAN be
// rendered is covered by the *.test.tsx component tests instead; this file
// only holds the leftovers:
//   C2-03  no service picker or cost call hands an empty calendarDates or drops
//          dates-only services (a repo-wide sweep, not one component).
//   C3-09  TimeframesEditor edits windows with TimeframeTimeInput (accepts
//          GTFS times past 24:00), never <input type="time">.
//   C3-17  ExportDialog's orphan cleanup is one undo step.
//   C5-08  the access isochrone counts "Resident workers", not "Jobs".
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const componentsDir = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(componentsDir, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('dates-only services reach every consumer (C2-03)', () => {
  const files = sourceFiles(componentsDir);

  it('scans the component tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no component passes an empty calendarDates to a service/cost helper', () => {
    const offenders = files.filter((f) => /calendarDates:\s*\[\]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no component filters dates-only services out of a picker', () => {
    const offenders = files.filter((f) => /\.filter\(\(\w+\)\s*=>\s*!\w+\.datesOnly\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('TimeframesEditor time inputs (C3-09)', () => {
  it('uses TimeframeTimeInput and no native time input', () => {
    const src = read('fares/TimeframesEditor.tsx');
    expect(src).toMatch(/<TimeframeTimeInput\b/);
    expect(src).not.toMatch(/type=["']time["']/);
  });
});

describe('ExportDialog orphan cleanup (C3-17)', () => {
  it('removes orphaned trips inside one history transaction', () => {
    expect(read('import-export/ExportDialog.tsx')).toMatch(/historyTransaction\('remove orphaned trips',/);
  });
});

describe('access isochrone opportunity label (C5-08)', () => {
  it('says "Resident workers", not "Jobs"', () => {
    const src = read('analysis/AccessIsochronePanel.tsx');
    expect(src).toContain('label="Resident workers"');
    expect(src).not.toMatch(/Jobs \(workers\)/);
  });
});
