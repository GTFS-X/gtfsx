// E2E E5: the Import Options screen (replace/merge + route picker) had no ×,
// no Cancel and no Escape; the only way out was "← Back" then Cancel. It now
// has all three, and each closes the dialog without importing (nothing is
// written before the confirm button on this step).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createImportSession, isImportOptionsStep } from '../importGuards';

const src = readFileSync(fileURLToPath(new URL('../ImportDialog.tsx', import.meta.url)), 'utf8');
const optionsStep = src.slice(src.indexOf('// ── Step 2: Mode + route selection'));

describe('Import Options cancel', () => {
  it('is the parsed-but-not-imported step', () => {
    expect(isImportOptionsStep({}, null)).toBe(true);
    expect(isImportOptionsStep(null, null)).toBe(false);
    expect(isImportOptionsStep({}, { routes: 1 })).toBe(false);
  });

  it('has a × and a Cancel button that close the dialog', () => {
    expect(optionsStep).toMatch(/onClick=\{handleClose\}\s*aria-label="Cancel import"/);
    expect(optionsStep).toMatch(/onClick=\{handleClose\}[^>]*>\s*Cancel\s*<\/button>/);
  });

  it('Escape closes it only on this step', () => {
    expect(src).toMatch(/const onOptionsStep = isImportOptionsStep\(parsedData, importedCounts\)/);
    expect(src).toMatch(/if \(!onOptionsStep\) return;[\s\S]*?e\.key === 'Escape'\) handleClose\(\)/);
  });

  it('closing aborts the session, so nothing in flight can land afterwards', () => {
    const session = createImportSession();
    session.close();
    expect(session.closed).toBe(true);
    expect(session.signal.aborted).toBe(true);
  });
});
