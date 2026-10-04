// C5-04 ($0 override honoured) and C5-07 (CSV quoting).
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_PER_REVENUE_HOUR, DEFAULT_DEADHEAD_FACTOR } from '../../../services/costEstimation';
import { costCsv, resolveRouteCost, routeTabCosts } from '../costRows';
import type { RouteSpans } from '../../../services/costEstimation';

describe('resolveRouteCost', () => {
  it('honours a $0 override and flags only a missing one as default', () => {
    expect(resolveRouteCost(0, 100)).toEqual({ costPerHour: 0, isDefault: false });
    expect(resolveRouteCost(null, 100)).toEqual({ costPerHour: 100, isDefault: true });
    expect(resolveRouteCost(undefined, 100).isDefault).toBe(true);
    expect(resolveRouteCost(75, 100)).toEqual({ costPerHour: 75, isDefault: false });
  });
  it('shares the documented defaults', () => {
    expect(DEFAULT_COST_PER_REVENUE_HOUR).toBe(100);
    expect(DEFAULT_DEADHEAD_FACTOR).toBe(1.1);
  });
});

describe('costCsv', () => {
  it('round-trips a route name containing quotes and neutralises formulas', () => {
    const rows = [['Route', 'Cost'], ['5 "Express"', '10'], ['=SUM(A1)', '1']];
    const parsed = Papa.parse<string[]>(costCsv(rows)).data;
    expect(parsed[1]).toEqual(['5 "Express"', '10']);
    expect(parsed[2][0]).toBe("'=SUM(A1)");
  });
});

describe('routeTabCosts (C5-05: Route › Costs uses the panel defaults)', () => {
  // 10 revenue hours a weekday, 5 days a week, 250 service days a year.
  const spans: RouteSpans = {
    weeklyRevHours: 50,
    weeklyTotalHoursBase: 50,
    tripsPerWeek: 100,
    peakVehicles: 2,
    _serviceBreakdown: [{ serviceId: 'WK', revHours: 10, daysPerWeek: 5, serviceDaysPerYear: 250, peak: 2 }],
  };

  it('uses $100/hr and a 1.1 deadhead factor when the route has no override', () => {
    const { stats, costPerHour, isDefault } = routeTabCosts(spans, undefined);
    expect(costPerHour).toBe(DEFAULT_COST_PER_REVENUE_HOUR);
    expect(isDefault).toBe(true);
    expect(stats.totalHoursWeekly).toBeCloseTo(50 * DEFAULT_DEADHEAD_FACTOR);
    expect(stats.weeklyCost).toBeCloseTo(10 * 1.1 * 100 * 5);
    expect(stats.annualCost).toBeCloseTo(10 * 1.1 * 100 * 250);
  });

  it('applies an explicit override, $0 included', () => {
    expect(routeTabCosts(spans, 0).stats.weeklyCost).toBe(0);
    expect(routeTabCosts(spans, 0).isDefault).toBe(false);
    expect(routeTabCosts(spans, 50).stats.weeklyCost).toBeCloseTo(10 * 1.1 * 50 * 5);
  });
});
