// C5-09 (stale runs dropped), C5-19 (hidden-route hints), C5-10 (effective service id).
import { describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { beginAnalysis, bumpAnalysisEpoch } from '../analysisEpoch';
import { allRoutesServingStopHidden, isRouteHidden } from '../hiddenRouteHints';
import { effectiveServiceId } from '../../analysis/effectiveServiceId';

describe('beginAnalysis', () => {
  it('is invalidated by Clear (bump) and by a newer run of the same kind', () => {
    const a = beginAnalysis('access');
    expect(a()).toBe(true);
    bumpAnalysisEpoch('access');
    expect(a()).toBe(false);
    const b = beginAnalysis('access');
    const c = beginAnalysis('access');
    expect(b()).toBe(false);
    expect(c()).toBe(true);
  });
  it('kinds are independent', () => {
    const cov = beginAnalysis('coverage');
    beginAnalysis('access');
    expect(cov()).toBe(true);
  });
  it('is invalidated by a feed switch', () => {
    const run = beginAnalysis('walkshed');
    useStore.getState().setProjectId('another-feed');
    expect(run()).toBe(false);
  });
});

describe('hidden route hints', () => {
  it('detects hidden routes and stops served only by hidden routes', () => {
    expect(isRouteHidden('R1', ['R1'])).toBe(true);
    const rs = [{ stop_id: 's', route_id: 'R1' }, { stop_id: 's', route_id: 'R2' }];
    expect(allRoutesServingStopHidden('s', rs, ['R1'])).toBe(false);
    expect(allRoutesServingStopHidden('s', rs, ['R1', 'R2'])).toBe(true);
    expect(allRoutesServingStopHidden('s', rs, [])).toBe(false);
  });
});

describe('effectiveServiceId', () => {
  it('drops a stale id', () => {
    expect(effectiveServiceId('GONE', [{ serviceId: 'wk' }])).toBeNull();
    expect(effectiveServiceId('wk', [{ serviceId: 'wk' }])).toBe('wk');
    expect(effectiveServiceId(null, [{ serviceId: 'wk' }])).toBeNull();
  });
});
