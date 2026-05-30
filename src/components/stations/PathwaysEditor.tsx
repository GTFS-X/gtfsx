import { useState } from 'react';
import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';
import type { Pathway } from '../../types/gtfs';

const PATHWAY_MODE_LABELS: Record<Pathway['pathway_mode'], string> = {
  1: 'Walkway',
  2: 'Stairs',
  3: 'Moving sidewalk',
  4: 'Escalator',
  5: 'Elevator',
  6: 'Fare gate',
  7: 'Exit gate',
};

/**
 * pathways.txt editor — basic table of in-station connections. Each row links
 * two stop nodes (any location_type: station, platform, entrance, generic node,
 * boarding area) with a mode and direction. Optional length / traversal time /
 * stair count / signage are exposed; rarer columns (max_slope, min_width, the
 * reversed signpost) still round-trip on import/export. No map drawing here.
 */
export function PathwaysEditor() {
  const pathways = useStore((s) => s.pathways);
  const stops = useStore((s) => s.stops);
  const addPathway = useStore((s) => s.addPathway);
  const updatePathway = useStore((s) => s.updatePathway);
  const removePathway = useStore((s) => s.removePathway);

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const stopOptions = [...stops]
    .sort((a, b) => a.stop_name.localeCompare(b.stop_name))
    .map((s) => ({ value: s.stop_id, label: s.stop_name || s.stop_id }));
  const stopName = (id: string) => stops.find((s) => s.stop_id === id)?.stop_name || id || '—';

  const handleAdd = () => {
    const first = stops[0]?.stop_id || '';
    const second = stops[1]?.stop_id || first;
    addPathway({
      pathway_id: generateId('pathway'),
      from_stop_id: first,
      to_stop_id: second,
      pathway_mode: 1,
      is_bidirectional: 1,
    });
  };

  const numOrU = (raw: string): number | undefined => {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  return (
    <div>
      {stops.length < 2 && (
        <div className="mb-3 p-3 rounded-lg bg-gold-light border-2 border-amber-300">
          <p className="text-amber-700 text-sm font-semibold">
            Add at least two stops (e.g. a station and its platforms) before defining pathways.
          </p>
        </div>
      )}

      {pathways.length === 0 ? (
        <div className="mb-3 p-4 rounded-lg bg-cream text-sm text-warm-gray">
          No pathways defined. Add walkways, stairs, or elevators connecting points
          inside a station so trip planners can route riders between platforms.
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {pathways.map((p, idx) => {
            const isCollapsed = collapsed.has(idx);
            return (
              <div key={idx} className="border border-sand rounded-lg bg-white">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-cream"
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(idx); else next.add(idx);
                    setCollapsed(next);
                  }}
                >
                  <span className="font-semibold text-dark-brown text-sm flex-1 truncate">
                    {stopName(p.from_stop_id)} {p.is_bidirectional === 1 ? '↔' : '→'} {stopName(p.to_stop_id)}
                  </span>
                  <span className="text-[11px] text-warm-gray whitespace-nowrap">
                    {PATHWAY_MODE_LABELS[p.pathway_mode] ?? `Mode ${p.pathway_mode}`}
                  </span>
                  <span className="text-warm-gray text-xs">{isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="px-3 py-3 border-t border-sand grid grid-cols-2 gap-2">
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      From stop
                      <select
                        value={p.from_stop_id}
                        onChange={(e) => updatePathway(idx, { from_stop_id: e.target.value })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {stopOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      To stop
                      <select
                        value={p.to_stop_id}
                        onChange={(e) => updatePathway(idx, { to_stop_id: e.target.value })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {stopOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Mode
                      <select
                        value={p.pathway_mode}
                        onChange={(e) => updatePathway(idx, { pathway_mode: Number(e.target.value) as Pathway['pathway_mode'] })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {Object.entries(PATHWAY_MODE_LABELS).map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Direction
                      <select
                        value={p.is_bidirectional}
                        onChange={(e) => updatePathway(idx, { is_bidirectional: Number(e.target.value) as 0 | 1 })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        <option value={1}>Bidirectional</option>
                        <option value={0}>One-way (from → to)</option>
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Length (m)
                      <input
                        type="number" min={0}
                        value={p.length ?? ''}
                        onChange={(e) => updatePathway(idx, { length: numOrU(e.target.value) })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                      />
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Traversal (s)
                      <input
                        type="number" min={0}
                        value={p.traversal_time ?? ''}
                        onChange={(e) => updatePathway(idx, { traversal_time: numOrU(e.target.value) })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                      />
                    </label>
                    {(p.pathway_mode === 2) && (
                      <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                        Stair count
                        <input
                          type="number"
                          value={p.stair_count ?? ''}
                          onChange={(e) => updatePathway(idx, { stair_count: numOrU(e.target.value) })}
                          className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                        />
                      </label>
                    )}
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide col-span-2">
                      Signposted as (optional)
                      <input
                        value={p.signposted_as || ''}
                        onChange={(e) => updatePathway(idx, { signposted_as: e.target.value || undefined })}
                        placeholder="Signage text riders follow"
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      />
                    </label>
                    <button
                      onClick={() => removePathway(idx)}
                      className="col-span-2 mt-1 text-[11px] text-red-400 hover:text-red-600 text-left"
                    >
                      Delete pathway
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={handleAdd}
        disabled={stops.length < 2}
        className="w-full px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-40"
      >
        + Add Pathway
      </button>
    </div>
  );
}
