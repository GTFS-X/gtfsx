import Papa from 'papaparse';
import {
  applyRouteCosts,
  DEFAULT_COST_PER_REVENUE_HOUR,
  DEFAULT_DEADHEAD_FACTOR,
  type RouteSpans,
  type RouteStats,
} from '../../services/costEstimation';

/** Per-route cost-per-hour: an explicit override (0 included) wins over the default. */
export function resolveRouteCost(
  override: number | null | undefined,
  defaultCostPerHour: number,
): { costPerHour: number; isDefault: boolean } {
  return override == null
    ? { costPerHour: defaultCostPerHour, isDefault: true }
    : { costPerHour: override, isDefault: false };
}

/** CSV text with proper quote escaping and spreadsheet-formula neutralisation. */
export function costCsv(rows: (string | number)[][]): string {
  return Papa.unparse(rows, { escapeFormulae: true });
}

/** Route › Costs tab figures (C5-05): the same defaults as the Costs panel
 *  and the docs ($100/revenue hour when the route has no override, deadhead
 *  factor 1.1), instead of the tab's old $0 and 1.2. */
export function routeTabCosts(
  spans: RouteSpans,
  override: number | null | undefined,
): { stats: RouteStats; costPerHour: number; isDefault: boolean } {
  const { costPerHour, isDefault } = resolveRouteCost(override, DEFAULT_COST_PER_REVENUE_HOUR);
  return { stats: applyRouteCosts(spans, costPerHour, DEFAULT_DEADHEAD_FACTOR), costPerHour, isDefault };
}
