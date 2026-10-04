import Papa from 'papaparse';

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
