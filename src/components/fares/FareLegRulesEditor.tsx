import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Breadcrumb } from '../ui/Breadcrumb';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareLegRule } from '../../types/gtfs';
import { describeRemovalBlockers, uniqueProductIds } from './fareEditorHelpers';
import { RemovalBlockedNotice } from './RemovalBlockedNotice';
import { IdSelect } from './IdSelect';

/**
 * GTFS-Fares v2 Fare Leg Rules editor (fare_leg_rules.txt). A leg rule sets the
 * fare for a single leg by joining (optionally) a network, from/to areas, and
 * from/to timeframes to a fare_product. fare_product_id is the only required
 * field. leg_group_id (optional) groups legs so transfer rules can reference
 * them. Rows are addressed by index (no single-column key).
 */
export function FareLegRulesEditor() {
  const fareLegRules = useStore((s) => s.fareLegRules);
  const fareProducts = useStore((s) => s.fareProducts);
  const fareNetworks = useStore((s) => s.fareNetworks);
  const fareAreas = useStore((s) => s.fareAreas);
  const timeframes = useStore((s) => s.timeframes);
  const addFareLegRule = useStore((s) => s.addFareLegRule);
  const updateFareLegRule = useStore((s) => s.updateFareLegRule);
  const removeFareLegRule = useStore((s) => s.removeFareLegRule);

  const [selectedIndex, setSelectedIndexRaw] = useState<number | null>(null);
  // Why the last delete was refused (S1-16); cleared when the selection changes.
  const [blocked, setBlocked] = useState<string | null>(null);
  const setSelectedIndex = (i: number | null) => { setSelectedIndexRaw(i); setBlocked(null); };

  const selected = selectedIndex != null ? fareLegRules[selectedIndex] ?? null : null;

  const timeframeGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tf of timeframes) ids.add(tf.timeframe_group_id);
    return [...ids];
  }, [timeframes]);
  const timeframeOptions = timeframeGroupIds.map((id) => ({ id }));
  const areaOptions = fareAreas.map((a) => ({ id: a.area_id, label: a.area_name }));

  const productLabel = (id?: string) =>
    fareProducts.find((p) => p.fare_product_id === id)?.fare_product_name || id || '(no product)';
  const networkLabel = (id?: string) =>
    fareNetworks.find((n) => n.network_id === id)?.network_name || id;
  const areaLabel = (id?: string) =>
    fareAreas.find((a) => a.area_id === id)?.area_name || id;

  const handleAdd = () => {
    const rule: FareLegRule = {
      leg_group_id: generateId('leg'),
      fare_product_id: fareProducts[0]?.fare_product_id ?? '',
    };
    addFareLegRule(rule);
    setSelectedIndex(fareLegRules.length); // new row is appended at the end
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Leg rules</strong> price a single leg of travel by matching a network, from/to
            areas, and time windows to a fare product. Only the fare product is required — leave the
            rest blank to match any leg.
          </p>
        </div>

        <RailSubHeading count={fareLegRules.length}>Fare Leg Rules</RailSubHeading>

        {fareProducts.length === 0 && (
          <p className="text-[12px] text-amber-700 mb-3">
            Add a fare product first — leg rules must point at one.
          </p>
        )}

        <div className="space-y-1.5 mb-3">
          {fareLegRules.map((rule, i) => (
            <button
              key={i}
              onClick={() => setSelectedIndex(i)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
            >
              <div className="font-medium truncate">{productLabel(rule.fare_product_id)}</div>
              <div className="text-[11px] text-warm-gray mt-0.5 truncate">
                {[
                  rule.network_id && `net: ${networkLabel(rule.network_id)}`,
                  rule.from_area_id && `from: ${areaLabel(rule.from_area_id)}`,
                  rule.to_area_id && `to: ${areaLabel(rule.to_area_id)}`,
                  rule.leg_group_id && `group: ${rule.leg_group_id}`,
                ].filter(Boolean).join(' · ') || 'matches any leg'}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          disabled={fareProducts.length === 0}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-sand disabled:hover:text-warm-gray"
        >
          + Add Leg Rule
        </button>
      </div>
    );
  }

  const idx = selectedIndex!;

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray mb-1">
        <Breadcrumb
          items={[
            { label: 'Leg Rules', onClick: () => setSelectedIndex(null) },
            { label: productLabel(selected.fare_product_id), className: 'truncate' },
          ]}
        />
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          Leg Rule
        </h2>
        <EditActions
          onDelete={() => {
            const result = removeFareLegRule(idx);
            if (result.removed) setSelectedIndex(null);
            else setBlocked(describeRemovalBlockers('this leg rule', result, useStore.getState()));
          }}
          deleteTitle="Delete this leg rule"
        />
      </div>
      <RemovalBlockedNotice message={blocked} onDismiss={() => setBlocked(null)} />

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Fare Product <span className="text-coral">*</span>
        </label>
        <select
          value={selected.fare_product_id}
          onChange={(e) => updateFareLegRule(idx, { fare_product_id: e.target.value })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          {selected.fare_product_id && !fareProducts.some((p) => p.fare_product_id === selected.fare_product_id) && (
            <option value={selected.fare_product_id}>{selected.fare_product_id} (missing)</option>
          )}
          {fareProducts.length === 0 && <option value="">No products</option>}
          {uniqueProductIds(fareProducts).map((p) => (
            <option key={p.fare_product_id} value={p.fare_product_id}>
              {p.fare_product_name || p.fare_product_id}
            </option>
          ))}
        </select>
      </div>

      <FormField
        label="Leg Group ID"
        value={selected.leg_group_id ?? ''}
        onChange={(v) => updateFareLegRule(idx, { leg_group_id: v || undefined })}
        placeholder="Groups legs for transfer rules (optional)"
      />

      <div className="mb-3">
        <IdSelect
          label="Network"
          anyLabel="Any network"
          value={selected.network_id}
          options={fareNetworks.map((n) => ({ id: n.network_id, label: n.network_name }))}
          onChange={(v) => updateFareLegRule(idx, { network_id: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <IdSelect
          label="From Area"
          value={selected.from_area_id}
          options={areaOptions}
          onChange={(v) => updateFareLegRule(idx, { from_area_id: v })}
        />
        <IdSelect
          label="To Area"
          value={selected.to_area_id}
          options={areaOptions}
          onChange={(v) => updateFareLegRule(idx, { to_area_id: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <IdSelect
          label="From Timeframe"
          value={selected.from_timeframe_group_id}
          options={timeframeOptions}
          onChange={(v) => updateFareLegRule(idx, { from_timeframe_group_id: v })}
        />
        <IdSelect
          label="To Timeframe"
          value={selected.to_timeframe_group_id}
          options={timeframeOptions}
          onChange={(v) => updateFareLegRule(idx, { to_timeframe_group_id: v })}
        />
      </div>

      <FormField
        label="Rule Priority"
        type="number"
        value={selected.rule_priority != null ? String(selected.rule_priority) : ''}
        onChange={(v) => updateFareLegRule(idx, { rule_priority: v === '' ? undefined : Number(v) })}
        placeholder="Higher wins ties (optional)"
      />
    </div>
  );
}
