import { useMemo } from 'react';
import { useStore } from '../../store';
import { calculateRouteSpans, DEFAULT_COST_PER_REVENUE_HOUR, DEFAULT_DEADHEAD_FACTOR } from '../../services/costEstimation';
import { routeTabCosts } from '../costs/costRows';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import type { Route } from '../../types/gtfs';

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/**
 * Cost estimation tab for a route's detail panel. Sits in the slot the
 * Frequencies placeholder used to occupy. Lets the user enter a cost per
 * revenue hour and surfaces derived weekly/annual operating cost figures.
 */
export function RouteCostsTab() {
  const routes = useStore((s) => s.routes);
  const editingRouteId = useStore((s) => s.editingRouteId);
  const route: Route | undefined = useStore((s) =>
    editingRouteId ? s.routes.find((r) => r.route_id === editingRouteId) : undefined,
  );
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const frequencies = useStore((s) => s.frequencies);
  const updateRoute = useStore((s) => s.updateRoute);
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const spans = useMemo(
    () => route ? calculateRouteSpans(route.route_id, { routes, trips, stopTimes, calendars, calendarDates, stopTimesByTrip, frequencies }) : null,
    [route, routes, trips, stopTimes, calendars, calendarDates, stopTimesByTrip, frequencies],
  );

  // Same defaults as the Costs panel and the docs (C5-05).
  const costs = useMemo(
    () => (spans && route) ? routeTabCosts(spans, route._cost_per_revenue_hour) : null,
    [spans, route],
  );

  if (!route || !costs) return null;
  const { stats, isDefault } = costs;

  return (
    <div>
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Cost per Revenue Hour ($)
        </label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={route._cost_per_revenue_hour ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            updateRoute(route.route_id, {
              _cost_per_revenue_hour: val === '' ? undefined : Number(val),
            });
          }}
          placeholder={`${DEFAULT_COST_PER_REVENUE_HOUR} (default)`}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white transition-colors"
        />
        <p className="mt-1.5 text-[11px] text-warm-gray">
          Fully-loaded operating cost per hour of revenue service. Leave blank to use the
          default (${DEFAULT_COST_PER_REVENUE_HOUR}/hr). Total hours include a {DEFAULT_DEADHEAD_FACTOR}× deadhead factor.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-warm-gray">Weekly Revenue Hours</span>
          <span className="font-semibold text-dark-brown">{stats.revenueHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Total Hours (w/ deadhead)</span>
          <span className="font-semibold text-dark-brown">{stats.totalHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Trips / Week</span>
          <span className="font-semibold text-dark-brown">{stats.tripsPerWeek}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Peak Vehicles</span>
          <span className="font-semibold text-dark-brown">{stats.peakVehicles}</span>
        </div>
        <div className="h-px bg-sand my-1" />
        <div className="flex justify-between">
          <span className="text-warm-gray">
            Weekly Cost{isDefault && <span className="ml-1">(default rate)</span>}
          </span>
          <span className="font-semibold text-coral">{formatCurrency(stats.weeklyCost)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Annual Cost</span>
          <span className="font-semibold text-coral">{formatCurrency(stats.annualCost)}</span>
        </div>
      </div>
    </div>
  );
}
