import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { calculateRouteStats, calculateSystemStats } from '../../services/costEstimation';
import type { RouteStats } from '../../services/costEstimation';

function formatCurrency(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

export function CostSummary() {
  const {
    routes, trips, stopTimes, calendars, calendarDates,
    selectRoute, setEditingRouteId, setSidebarSection,
  } = useStore();

  const [defaultCostPerHour, setDefaultCostPerHour] = useState(50);

  const stateSlice = useMemo(
    () => ({ routes, trips, stopTimes, calendars, calendarDates }),
    [routes, trips, stopTimes, calendars, calendarDates]
  );

  const systemStats = useMemo(
    () => calculateSystemStats(stateSlice, defaultCostPerHour),
    [stateSlice, defaultCostPerHour]
  );

  const routeRows = useMemo(() => {
    return routes.map((route) => ({
      route,
      stats: calculateRouteStats(route.route_id, stateSlice, defaultCostPerHour),
    }));
  }, [routes, stateSlice, defaultCostPerHour]);

  const handleOpenRoute = (routeId: string) => {
    selectRoute(routeId);
    setEditingRouteId(routeId);
    setSidebarSection('routes');
  };

  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Cost Summary</h3>

      {/* Default cost per hour input */}
      <div className="bg-cream rounded-lg p-3 mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Default Cost per Revenue Hour
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-dark-brown font-semibold">$</span>
          <input
            type="number"
            min={0}
            step={1}
            value={defaultCostPerHour}
            onChange={(e) => setDefaultCostPerHour(Math.max(0, Number(e.target.value)))}
            className="w-24 px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral tabular-nums"
          />
          <span className="text-xs text-warm-gray">/ hour</span>
        </div>
        <p className="text-[11px] text-warm-gray mt-1.5">
          Applied to routes without a route-specific cost. Override per route in the route editor.
        </p>
      </div>

      {/* System totals */}
      <div className="bg-cream rounded-lg p-3 mb-4">
        <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          System Totals
        </div>
        <div className="flex flex-col gap-1.5 text-sm">
          <StatRow label="Daily Revenue Hours" value={systemStats.totalRevenueHoursDaily.toFixed(1)} />
          <StatRow label="Total Trips / Day" value={String(systemStats.totalTripsPerDay)} />
          <StatRow label="Peak Vehicles" value={String(systemStats.totalPeakVehicles)} />
          <div className="h-px bg-sand my-1" />
          <StatRow label="Daily Cost" value={formatCurrency(systemStats.totalDailyCost)} highlight />
          <StatRow label="Annual Cost" value={formatCurrency(systemStats.totalAnnualCost)} highlight />
        </div>
      </div>

      {/* Per-route breakdown */}
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
        Per-Route Breakdown
      </div>

      {routes.length === 0 ? (
        <p className="text-xs text-warm-gray">No routes created yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {routeRows.map(({ route, stats }) => {
            const hasCustomCost = route._cost_per_revenue_hour != null && route._cost_per_revenue_hour > 0;
            return (
              <RouteCard
                key={route.route_id}
                name={route.route_short_name || route.route_long_name || 'Untitled Route'}
                color={route.route_color}
                stats={stats}
                costPerHour={hasCustomCost ? route._cost_per_revenue_hour! : defaultCostPerHour}
                isDefault={!hasCustomCost}
                onEditRoute={() => handleOpenRoute(route.route_id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-warm-gray">{label}</span>
      <span className={`font-semibold ${highlight ? 'text-coral' : 'text-dark-brown'}`}>{value}</span>
    </div>
  );
}

function RouteCard({
  name,
  color,
  stats,
  costPerHour,
  isDefault,
  onEditRoute,
}: {
  name: string;
  color: string;
  stats: RouteStats;
  costPerHour: number;
  isDefault: boolean;
  onEditRoute: () => void;
}) {
  return (
    <div className="border-2 border-sand rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: `#${color}` }}
        />
        <span className="font-semibold text-sm text-dark-brown truncate flex-1">{name}</span>
        <button
          onClick={onEditRoute}
          className="text-[11px] font-semibold text-warm-gray hover:text-coral transition-colors"
        >
          Edit
        </button>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <div className="flex justify-between">
          <span className="text-warm-gray">Rev Hours</span>
          <span className="text-dark-brown font-medium">{stats.revenueHoursDaily.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Trips</span>
          <span className="text-dark-brown font-medium">{stats.tripsPerDay}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Peak Vehicles</span>
          <span className="text-dark-brown font-medium">{stats.peakVehicles}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Cost/Hour</span>
          <span className="text-dark-brown font-medium">
            ${costPerHour}
            {isDefault && <span className="text-warm-gray ml-1">(default)</span>}
          </span>
        </div>
        <div className="h-px bg-sand my-0.5" />
        <div className="flex justify-between">
          <span className="text-warm-gray">Daily Cost</span>
          <span className="text-coral font-semibold">{formatCurrency(stats.dailyCost)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Annual Cost</span>
          <span className="text-coral font-semibold">{formatCurrency(stats.annualCost)}</span>
        </div>
      </div>
    </div>
  );
}
