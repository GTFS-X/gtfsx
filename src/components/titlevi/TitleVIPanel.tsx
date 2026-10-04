import { useState, useCallback, useEffect } from 'react';
import { EmptyState } from '../ui/EmptyState';
import { useVisibleFeed } from '../../hooks/useVisibleFeed';
import { RouteScopeNote } from '../ui/RouteScopeNote';
import { useStore } from '../../store';
import { fetchServiceAreaBlockGroups } from '../coverage/serviceAreaCensus';
import { beginAnalysis, bumpAnalysisEpoch } from '../coverage/analysisEpoch';
import { TITLE_VI_METHOD_NOTE, titleVIBasisLabel } from './titleVIText';
import { calculateTitleVI, type TitleVIResult, type TitleVIGroup } from '../../services/titleVI';

function fmt(n: number, decimals = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function pct(share: number): string {
  return (share * 100).toFixed(1) + '%';
}

function RatioIndicator({ ratio }: { ratio: number | null }) {
  if (ratio === null) {
    return (
      <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-warm-gray bg-white border-gray-200">
        <span className="text-sm font-bold">n/a</span>
        <span className="text-xs font-medium">Insufficient data for a comparison</span>
      </div>
    );
  }
  const color =
    ratio >= 1.0 ? 'text-emerald-600 bg-emerald-50 border-emerald-200' :
    ratio >= 0.8 ? 'text-amber-600 bg-amber-50 border-amber-200' :
                   'text-red-600 bg-red-50 border-red-200';
  const label =
    ratio >= 1.0 ? 'Equitable' :
    ratio >= 0.8 ? 'Moderate disparity' :
                   'Potential disparity';
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${color}`}>
      <span className="text-sm font-bold">{fmt(ratio, 2)}</span>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function GroupColumn({ label, group, isMinority }: { label: string; group: TitleVIGroup; isMinority: boolean }) {
  return (
    <div className={`flex-1 rounded-lg p-3 space-y-2 ${isMinority ? 'bg-purple-50' : 'bg-teal-light'}`}>
      <p className={`text-xs font-bold uppercase tracking-wide ${isMinority ? 'text-purple' : 'text-teal'}`}>
        {label}
      </p>
      <div>
        <p className="font-heading font-bold text-lg text-dark-brown">{fmt(group.avgDailyTrips)}</p>
        <p className="text-[11px] text-warm-gray">avg. daily trips</p>
      </div>
      <div>
        <p className="font-heading font-bold text-sm text-dark-brown">{group.count}</p>
        <p className="text-[11px] text-warm-gray">block groups</p>
      </div>
      <div>
        <p className="font-heading font-bold text-sm text-dark-brown">{group.totalPop.toLocaleString()}</p>
        <p className="text-[11px] text-warm-gray">population</p>
      </div>
    </div>
  );
}

export function TitleVIPanel() {
  // Analysis is scoped to the routes toggled visible on the map.
  const { stops, stopTimes, trips, visibleRouteCount, totalRouteCount } = useVisibleFeed();
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const [result, setResult] = useState<TitleVIResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = useStore((s) => s.projectId);

  // A different feed: drop the previous feed's result and any run still in
  // flight for it (C5-09, same guard as Coverage / Access / Walkshed).
  useEffect(() => {
    bumpAnalysisEpoch('titlevi');
    setResult(null);
    setError(null);
    setLoading(false);
  }, [projectId]);

  const handleAnalyze = useCallback(async () => {
    if (stops.length === 0) return;
    // Grabbed before the first await: a result that lands after a newer run
    // or a feed switch is dropped instead of shown against the wrong feed.
    const isCurrent = beginAnalysis('titlevi');
    setLoading(true);
    setError(null);

    try {
      // Every county the service area touches, not just the centroid's.
      const blockGroups = await fetchServiceAreaBlockGroups(stops);
      if (!isCurrent()) return;
      // trips + calendars let the analysis use one representative service day
      // instead of summing every service pattern into "daily" trips.
      setResult(calculateTitleVI(stops, blockGroups, { stopTimes, trips, calendars, calendarDates }));
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [stops, stopTimes, trips, calendars, calendarDates]);

  if (stops.length === 0) {
    return totalRouteCount > 0 && visibleRouteCount === 0 ? (
      <EmptyState
        icon="⚖"
        title="All routes hidden"
        description="Toggle route visibility back on to run a Title VI analysis for those routes."
      />
    ) : (
      <EmptyState
        icon="⚖"
        title="No Stops Yet"
        description="Add stops to your routes before running a Title VI analysis."
      />
    );
  }

  return (
    <div className="space-y-4">
      <RouteScopeNote visible={visibleRouteCount} total={totalRouteCount} />
      <p className="text-xs text-warm-gray">
        Compares transit service levels between minority and non-minority block groups per
        FTA Circular 4702.1B. Threshold is the regional average minority share.
      </p>

      <button
        onClick={handleAnalyze}
        disabled={loading}
        className="w-full px-4 py-2.5 bg-teal text-white rounded-lg font-heading font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Analyzing…' : result ? 'Re-run Analysis' : 'Run Title VI Analysis'}
      </button>

      {loading && (
        <div className="text-center py-6">
          <div className="inline-block w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-sm text-warm-gray">Fetching Census race/ethnicity data…</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700 font-medium">Error</p>
          <p className="text-xs text-red-600 mt-1">{error}</p>
        </div>
      )}

      {result && !loading && (
        <div className="space-y-3">
          {titleVIBasisLabel(result.basis) && (
            <p className="text-xs font-semibold text-dark-brown" data-testid="titlevi-basis">
              {titleVIBasisLabel(result.basis)}
            </p>
          )}
          {/* ── Race / ethnicity ── */}
          <h3 className="font-heading font-bold text-sm text-dark-brown">Race / ethnicity</h3>
          <div className="bg-cream rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-warm-gray">Regional minority share (threshold)</span>
            <span className="text-sm font-bold text-dark-brown">{pct(result.regionalMinorityShare)}</span>
          </div>
          <div className="flex gap-2">
            <GroupColumn label="Minority" group={result.minority} isMinority={true} />
            <GroupColumn label="Non-Minority" group={result.nonMinority} isMinority={false} />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Minority / Non-Minority Ratio
            </p>
            <RatioIndicator ratio={result.ratio} />
            <p className="text-[10px] text-warm-gray mt-1">
              Ratio &lt; 1.0 indicates minority block groups receive fewer average daily
              trips. Ratios below 0.80 may warrant further review under FTA Circular 4702.1B.
            </p>
          </div>

          {/* ── Income (Environmental Justice) ── */}
          <h3 className="font-heading font-bold text-sm text-dark-brown pt-1">Income (Environmental Justice)</h3>
          <div className="bg-cream rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-warm-gray">Regional low-income share (threshold)</span>
            <span className="text-sm font-bold text-dark-brown">{pct(result.regionalLowIncomeShare)}</span>
          </div>
          <div className="flex gap-2">
            <GroupColumn label="Low-Income" group={result.lowIncome} isMinority={true} />
            <GroupColumn label="Higher-Income" group={result.nonLowIncome} isMinority={false} />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Low-Income / Higher-Income Ratio
            </p>
            <RatioIndicator ratio={result.lowIncomeRatio} />
            <p className="text-[10px] text-warm-gray mt-1">
              Low-income = block groups above the regional share of population under 200% of the
              federal poverty line. Ratio &lt; 1.0 indicates these areas receive fewer average daily trips.
            </p>
          </div>

          {/* Methodology note */}
          <p className="text-[10px] text-warm-gray border-t border-sand pt-2">
            {TITLE_VI_METHOD_NOTE}
          </p>
        </div>
      )}
    </div>
  );
}
