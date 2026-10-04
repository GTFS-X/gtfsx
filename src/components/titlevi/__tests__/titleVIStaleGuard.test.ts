// C5-09 for Title VI: Coverage, Access-isochrone and walkshed drop a result
// that lands after a newer run or a feed switch (analysisEpoch.ts). Title VI
// had no guard, so a slow Census fetch from feed A could paint its result
// into the panel after switching to feed B, and an older run could overwrite
// a newer one.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useStore } from '../../../store';
import { beginAnalysis, bumpAnalysisEpoch } from '../../coverage/analysisEpoch';

const src = readFileSync(fileURLToPath(new URL('../TitleVIPanel.tsx', import.meta.url)), 'utf8');

describe('Title VI analysis guard', () => {
  it('has its own epoch: invalidated by a newer Title VI run or a feed switch, not by other panels', () => {
    const a = beginAnalysis('titlevi');
    beginAnalysis('coverage');
    bumpAnalysisEpoch('access');
    expect(a()).toBe(true);
    const b = beginAnalysis('titlevi');
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    useStore.getState().setProjectId('titlevi-other-feed');
    expect(b()).toBe(false);
  });

  it('handleAnalyze takes the guard before awaiting and checks it before every state write', () => {
    const start = src.indexOf('const handleAnalyze = useCallback(async () => {');
    const body = src.slice(start, src.indexOf('}, [stops, stopTimes', start));
    const guard = body.indexOf("const isCurrent = beginAnalysis('titlevi')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('await '));
    expect(body).toMatch(/await fetchServiceAreaBlockGroups\(stops\);\s*if \(!isCurrent\(\)\) return;\s*[\s\S]*?setResult\(/);
    expect(body).toMatch(/catch \(err\) \{\s*if \(!isCurrent\(\)\) return;\s*setError\(/);
    expect(body).toMatch(/finally \{\s*if \(isCurrent\(\)\) setLoading\(false\);/);
  });

  it('a feed switch clears the shown result and invalidates an in-flight run', () => {
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*bumpAnalysisEpoch\('titlevi'\);\s*setResult\(null\);[\s\S]*?\}, \[projectId\]\);/,
    );
  });
});
