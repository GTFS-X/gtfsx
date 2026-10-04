// Fare editor regressions (B7): S1-16 refusal messages, C3-05 route vs
// zone-pair rules, C3-06/C3-17 one-step fare-type change, C3-07 transfer-rule
// labels and hints, C3-08 composite-key products, C3-09 timeframe times,
// C3-10 "(missing)" options, C3-27 case-insensitive type prefix.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStore } from '../../../store';
import { historyDepths, resetHistory, undo } from '../../../store/history';
import type { FareAttribute, FareProduct, FareTransferRule } from '../../../types/gtfs';
import {
  DURATION_TYPES,
  TRANSFER_TYPES,
  applyTypePrefix,
  describeRemovalBlockers,
  groupProductRows,
  isRouteRule,
  parseTimeframeTime,
  productRowCollides,
  routeRuleIndices,
  timeframeRowIssue,
  transferRuleHints,
} from '../fareEditorHelpers';
import { applyFareType, setFareAllRoutes } from '../fareActions';
import { IdSelect } from '../IdSelect';
import { TimeframeTimeInput } from '../TimeframeTimeInput';

const s = () => useStore.getState();

function reset() {
  s().setFareAttributes([]); s().setFareRules([]);
  s().setFareAreas([]); s().setStopAreas([]);
  s().setFareNetworks([]); s().setRouteNetworks([]);
  s().setTimeframes([]); s().setRiderCategories([]);
  s().setFareMedia([]); s().setFareProducts([]);
  s().setFareLegRules([]); s().setFareTransferRules([]);
  s().setFlexZones([]);
  resetHistory();
}
beforeEach(reset);
afterEach(reset);

const fare = (id: string, price = '2.00'): FareAttribute =>
  ({ fare_id: id, price, currency_type: 'USD', payment_method: 0, transfers: '' });

describe('C3-27 applyTypePrefix', () => {
  it('recognises a prefix regardless of case', () => {
    expect(applyTypePrefix('Senior-1', 'Regular')).toBe('1');
    expect(applyTypePrefix('SENIOR-1', 'Student')).toBe('student-1');
    expect(applyTypePrefix('senior-1', 'Regular')).toBe('1');
    expect(applyTypePrefix('1', 'Free')).toBe('free-1');
  });
});

describe('C3-05 route rules vs zone-pair rules', () => {
  beforeEach(() => {
    s().setFareAttributes([fare('F')]);
    s().setFareRules([
      { fare_id: 'F', origin_id: 'Z1', destination_id: 'Z2' },
      { fare_id: 'F', route_id: 'R1' },
      { fare_id: 'F', origin_id: 'Z2', destination_id: 'Z1' },
      { fare_id: 'G', route_id: 'R1' },
    ]);
    resetHistory();
  });

  it('isRouteRule excludes zone-pair and contains rules', () => {
    expect(isRouteRule({ fare_id: 'F', route_id: 'R1' })).toBe(true);
    expect(isRouteRule({ fare_id: 'F', origin_id: 'Z1' })).toBe(false);
    expect(isRouteRule({ fare_id: 'F', route_id: 'R1', contains_id: 'Z1' })).toBe(false);
  });

  it('the route list has one row for the fare', () => {
    expect(routeRuleIndices(s().fareRules, 'F')).toEqual([1]);
  });

  it('"All routes" removes only the route rule, in one undo step', () => {
    setFareAllRoutes('F');
    expect(s().fareRules).toEqual([
      { fare_id: 'F', origin_id: 'Z1', destination_id: 'Z2' },
      { fare_id: 'F', origin_id: 'Z2', destination_id: 'Z1' },
      { fare_id: 'G', route_id: 'R1' },
    ]);
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().fareRules).toHaveLength(4);
  });
});

describe('C3-06 / C3-17 fare-type chip', () => {
  it('renames the fare, its rules and its flex zone and zeroes Free, as one undo step', () => {
    s().setFareAttributes([fare('day', '5.00')]);
    s().setFareRules([{ fare_id: 'day', route_id: 'R1' }]);
    s().setFlexZones([{ id: 'Z', fareId: 'day' } as never]);
    resetHistory();
    const newId = applyFareType('day', 'Free');
    expect(newId).toBe('free-day');
    expect(s().fareAttributes[0]).toMatchObject({ fare_id: 'free-day', price: '0.00' });
    expect(s().fareRules[0].fare_id).toBe('free-day');
    expect((s().flexZones[0] as { fareId?: string }).fareId).toBe('free-day');
    expect(historyDepths().undo).toBe(1);
    undo();
    expect(s().fareAttributes[0]).toMatchObject({ fare_id: 'day', price: '5.00' });
    expect((s().flexZones[0] as { fareId?: string }).fareId).toBe('day');
  });

  it('an imported capitalised prefix can be switched back to Regular', () => {
    s().setFareAttributes([fare('Senior-1')]);
    expect(applyFareType('Senior-1', 'Regular')).toBe('1');
    expect(s().fareAttributes[0].fare_id).toBe('1');
  });
});

describe('S1-16 refused deletes are explained', () => {
  it('names the leg rules blocking an area delete and leaves state unchanged', () => {
    s().setFareAreas([{ area_id: 'AR' }]);
    s().setFareProducts([{ fare_product_id: 'P', amount: '1', currency: 'USD' }]);
    s().setFareLegRules([
      { leg_group_id: 'LG1', from_area_id: 'AR', fare_product_id: 'P' },
      { to_area_id: 'AR', fare_product_id: 'P' },
    ]);
    const result = s().removeFareArea('AR');
    expect(result.removed).toBe(false);
    expect(s().fareAreas).toHaveLength(1);
    const msg = describeRemovalBlockers('this area', result, s());
    expect(msg).toBe(
      "Can't delete this area: it is used by 2 leg rules (group LG1, leg rule #2). Change or remove those first.",
    );
  });

  it('lists transfer rules and products, and returns null when removed', () => {
    const msg = describeRemovalBlockers(
      'this product',
      { removed: false, fareLegRules: [], fareTransferRules: [0], fareProducts: [0] },
      {
        fareLegRules: [],
        fareTransferRules: [{ from_leg_group_id: 'A', fare_transfer_type: 0 }],
        fareProducts: [{ fare_product_id: 'P', amount: '1', currency: 'USD', rider_category_id: 'SEN' }],
      },
    );
    expect(msg).toContain('1 transfer rule (A → any)');
    expect(msg).toContain('1 fare product (P (SEN))');
    expect(describeRemovalBlockers('x', { removed: true, fareLegRules: [], fareTransferRules: [], fareProducts: [] }, s()))
      .toBeNull();
  });

  it('caps a long list', () => {
    const rules = Array.from({ length: 7 }, (_, i) => ({ leg_group_id: `G${i}`, fare_product_id: 'P' }));
    const msg = describeRemovalBlockers(
      'this network',
      { removed: false, fareLegRules: rules.map((_, i) => i), fareTransferRules: [], fareProducts: [] },
      { fareLegRules: rules, fareTransferRules: [], fareProducts: [] },
    );
    expect(msg).toContain('7 leg rules (group G0, group G1, group G2, group G3 and 3 more)');
  });
});

describe('C3-07 transfer-rule editor semantics', () => {
  it('labels follow the spec enum', () => {
    expect(TRANSFER_TYPES.map((t) => [t.value, t.label])).toEqual([
      [0, 'Pay first leg + transfer product (A + AB)'],
      [1, 'Pay both legs + transfer product (A + AB + B)'],
      [2, 'Transfer product replaces both legs (AB)'],
    ]);
    expect(DURATION_TYPES.map((d) => d.value)).toEqual([0, 1, 2, 3]);
  });

  it('a type-1 rule with no product has no hint (product is optional)', () => {
    const rule: FareTransferRule = { from_leg_group_id: 'A', to_leg_group_id: 'B', fare_transfer_type: 1 };
    expect(transferRuleHints(rule)).toEqual([]);
  });

  it('flags duration and transfer_count conditionals', () => {
    expect(transferRuleHints({ fare_transfer_type: 0, duration_limit: 600 })[0]).toMatch(/duration limit type/i);
    expect(transferRuleHints({ fare_transfer_type: 0, duration_limit_type: 3 })[0]).toMatch(/only allowed/i);
    expect(transferRuleHints({ from_leg_group_id: 'A', to_leg_group_id: 'A', fare_transfer_type: 0 })[0])
      .toMatch(/required/);
    expect(transferRuleHints({ from_leg_group_id: 'A', to_leg_group_id: 'B', fare_transfer_type: 0, transfer_count: 1 })[0])
      .toMatch(/only allowed/);
    expect(transferRuleHints({ from_leg_group_id: 'A', to_leg_group_id: 'A', fare_transfer_type: 0, transfer_count: 0 }))
      .toEqual(['Transfer count must be -1 (unlimited) or 1 or more.']);
  });
});

describe('C3-08 products by row', () => {
  const adult: FareProduct = { fare_product_id: 'single', amount: '2.50', currency: 'USD', rider_category_id: 'ADULT' };
  const senior: FareProduct = { fare_product_id: 'single', amount: '1.25', currency: 'USD', rider_category_id: 'SEN' };
  const pass: FareProduct = { fare_product_id: 'day', amount: '6', currency: 'USD' };

  it('groups rows by id and keeps each row index', () => {
    const groups = groupProductRows([adult, pass, senior]);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.index)])).toEqual([
      ['single', [0, 2]],
      ['day', [1]],
    ]);
  });

  it('editing the second row leaves the first alone', () => {
    s().setFareProducts([adult, senior]);
    s().updateFareProductAt(1, { amount: '1.00' });
    expect(s().fareProducts.map((p) => p.amount)).toEqual(['2.50', '1.00']);
  });

  it('rename moves every row of the product', () => {
    s().setFareProducts([adult, senior, pass]);
    s().renameFareProductId('single', 'one-ride');
    expect(s().fareProducts.map((p) => p.fare_product_id)).toEqual(['one-ride', 'one-ride', 'day']);
  });

  it('refuses a scope change that duplicates another row of the product', () => {
    const rows = [adult, senior];
    expect(productRowCollides(rows, 1, { rider_category_id: 'ADULT' })).toBe(true);
    expect(productRowCollides(rows, 1, { rider_category_id: 'STUDENT' })).toBe(false);
    expect(productRowCollides(rows, 1, { amount: '9' })).toBe(false);
  });

  it('deleting one row of a referenced product is allowed; the last row is refused', () => {
    s().setFareProducts([adult, senior]);
    s().setFareLegRules([{ fare_product_id: 'single' }]);
    expect(s().removeFareProductAt(1).removed).toBe(true);
    const last = s().removeFareProductAt(0);
    expect(last.removed).toBe(false);
    expect(describeRemovalBlockers('this fare product', last, s())).toContain('1 leg rule (leg rule #1)');
  });
});

describe('C3-09 timeframe times', () => {
  it('parses typed times, allows 24:00:00, rejects later and junk', () => {
    expect(parseTimeframeTime('')).toBeUndefined();
    expect(parseTimeframeTime('7:00')).toBe('07:00:00');
    expect(parseTimeframeTime('24:00:00')).toBe('24:00:00');
    expect(parseTimeframeTime('24:00:01')).toBeNull();
    expect(parseTimeframeTime('nope')).toBeNull();
  });

  it('flags an unpaired start or end', () => {
    expect(timeframeRowIssue({ timeframe_group_id: 'g', service_id: 's', start_time: '07:00:00' }))
      .toMatch(/both start and end/);
    expect(timeframeRowIssue({ timeframe_group_id: 'g', service_id: 's' })).toBeNull();
    expect(timeframeRowIssue({ timeframe_group_id: 'g', service_id: 's', start_time: '07:00:00', end_time: '24:00:00' }))
      .toBeNull();
  });

  it('the input shows 24:00:00 and an unpadded imported value', () => {
    const html = renderToStaticMarkup(createElement(TimeframeTimeInput, {
      value: '24:00:00', onCommit: () => {}, title: 'End', placeholder: 'End',
    }));
    expect(html).toContain('type="text"');
    expect(html).toContain('value="24:00:00"');
    const html2 = renderToStaticMarkup(createElement(TimeframeTimeInput, {
      value: '7:00:00', onCommit: () => {}, title: 'Start', placeholder: 'Start',
    }));
    expect(html2).toContain('value="7:00:00"');
  });
});

describe('C3-10 leg-rule selects show unknown ids', () => {
  it('renders "<id> (missing)" as the selected option', () => {
    const html = renderToStaticMarkup(createElement(IdSelect, {
      label: 'Network', anyLabel: 'Any network', value: 'ghost',
      options: [{ id: 'bus', label: 'Bus' }], onChange: () => {},
    }));
    expect(html).toMatch(/<option value="ghost" selected="">ghost \(missing\)<\/option>/);
  });

  it('no missing option for a known or blank value', () => {
    const known = renderToStaticMarkup(createElement(IdSelect, {
      label: 'Network', value: 'bus', options: [{ id: 'bus' }], onChange: () => {},
    }));
    expect(known).not.toContain('(missing)');
    const blank = renderToStaticMarkup(createElement(IdSelect, {
      label: 'Network', value: undefined, options: [{ id: 'bus' }], onChange: () => {},
    }));
    expect(blank).not.toContain('(missing)');
  });
});
