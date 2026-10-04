// C5-04 ($0 override honoured) and C5-07 (CSV quoting).
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_PER_REVENUE_HOUR, DEFAULT_DEADHEAD_FACTOR } from '../../../services/costEstimation';
import { costCsv, resolveRouteCost } from '../costRows';

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
