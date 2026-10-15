import { type ReactNode, useMemo, useState } from 'react';
import { Drawer } from '../ui/Drawer';
import { formatTimeShort, secondsToGtfsTime } from '../../utils/time';
import { checkFrequencyDrawer, frequencyTimeLabel, headwayMinutesInput, parseHeadwayMinutes, parseShiftMinutes } from './timetableGridHelpers';
import type { GenerateValidation, TimetableGenMode } from '../../services/timetableGen';
import { windowDepartureCount, type FrequencyWindow } from '../../services/frequencyExpansion';
import { speedUnit, type UnitSystem } from '../../utils/units';
import { avgSpeedBounds, formatAvgSpeedInput, parseAvgSpeedInput } from './avgSpeedInput';

/** The raw inputs a Generate submission carries up to the orchestrator, which
 *  builds the full GenerateTripsParams (it owns the pattern's routeStops / stops
 *  / shape) and calls the shared `generateTrips` service. */
export interface GenerateInput {
  startTime: string;
  endTime: string;
  headwaySecs: number;
  runSecs: number;
  mode: TimetableGenMode;
  /** Average speed (mph) the end-to-end time was estimated at — remembered on
   *  the route so the next estimate starts from it. */
  avgSpeedMph: number;
}

const TIN = 'h-[30px] rounded-md border border-sand bg-white font-mono text-[12.5px] text-dark-brown px-2 text-center focus:outline-none focus:border-coral';
const TIN_TIME = `${TIN} w-[74px]`;
const TIN_NUM = `${TIN} w-[54px]`;
const HEADWAY_PRESETS = [10, 15, 20, 30, 60];
const VR = <span className="w-px h-[18px] bg-sand" aria-hidden="true" />;

/* ---------- ✨ Generate trips ---------- */
export function GenerateDrawer({
  ctx, initialSpeedMph, unitSystem, estimateRunMin, getPreview, onApply, onCancel,
}: {
  ctx: string;
  /** Starting average speed (mph): the route's last-used speed, or the default. */
  initialSpeedMph: number;
  /** Display units for the speed field (mph / km/h). */
  unitSystem: UnitSystem;
  /** End-to-end minutes for this pattern at a given average speed (mph). */
  estimateRunMin: (avgSpeedMph: number) => number;
  getPreview: (input: GenerateInput) => GenerateValidation;
  onApply: (input: GenerateInput) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState('06:00');
  const [to, setTo] = useState('22:00');
  const [head, setHead] = useState(30);
  const [run, setRun] = useState(() => estimateRunMin(initialSpeedMph));
  const [mode, setMode] = useState<TimetableGenMode>('explicit');
  // The typed speed text belongs to the unit system it was typed in. If the
  // preference flips while the drawer is open, re-show the last good mph value
  // in the new unit rather than reinterpreting "20" as 20 km/h.
  const [speed, setSpeed] = useState<{ mph: number; text: string; system: UnitSystem }>(
    () => ({ mph: initialSpeedMph, text: formatAvgSpeedInput(initialSpeedMph, unitSystem), system: unitSystem }),
  );
  const speedText = speed.system === unitSystem ? speed.text : formatAvgSpeedInput(speed.mph, unitSystem);
  const speedParse = parseAvgSpeedInput(speedText, unitSystem);
  const { min: speedMin, max: speedMax } = avgSpeedBounds(unitSystem);
  const onSpeedChange = (text: string) => {
    const parsed = parseAvgSpeedInput(text, unitSystem);
    setSpeed({ mph: parsed.ok ? parsed.mph : speed.mph, text, system: unitSystem });
    // A new speed re-derives the end-to-end time; the planner can still
    // override the minutes by hand afterwards.
    if (parsed.ok) setRun(estimateRunMin(parsed.mph));
  };

  const input: GenerateInput = {
    startTime: from, endTime: to, headwaySecs: head * 60, runSecs: run * 60, mode, avgSpeedMph: speed.mph,
  };
  const preview = getPreview(input);
  const canApply = preview.ok && speedParse.ok;
  const count = !speedParse.ok
    ? <span className="text-red-500">{speedParse.error}</span>
    : mode === 'frequency'
      ? (preview.ok ? 'Creates 1 reference trip + a frequency window' : (preview.error ?? '—'))
      : (preview.ok ? `Creates ${preview.tripCount} trip${preview.tripCount === 1 ? '' : 's'}` : (preview.error ?? '—'));

  return (
    <Drawer
      icon="✨"
      iconClassName="bg-coral-light text-coral"
      title="Generate trips"
      sub={`${ctx} — set a window and an interval; we'll lay out the day's trips.`}
      count={count}
      applyLabel={mode === 'frequency' ? 'Generate frequency window' : `Generate ${preview.ok ? `${preview.tripCount} ` : ''}trips`}
      canApply={canApply}
      onApply={() => onApply(input)}
      onCancel={onCancel}
    >
      <span>Run from</span>
      <input className={TIN_TIME} value={from} onChange={(e) => setFrom(e.target.value)} />
      <span>to</span>
      <input className={TIN_TIME} value={to} onChange={(e) => setTo(e.target.value)} />
      {VR}
      <span>A bus every</span>
      <input className={TIN_NUM} type="number" min={1} value={head} onChange={(e) => setHead(Math.max(1, Number(e.target.value) || 0))} />
      <span>min</span>
      {HEADWAY_PRESETS.map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => setHead(h)}
          className={`h-6 px-2.5 rounded border font-heading font-bold text-[11.5px] ${
            head === h ? 'bg-coral border-coral text-white' : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]'
          }`}
        >
          {h}
        </button>
      ))}
      <span className="basis-full h-0" />
      <label htmlFor="gen-avg-speed">Average speed</label>
      <input
        id="gen-avg-speed"
        className={`${TIN} w-[70px] ${speedParse.ok ? '' : 'border-red-400 focus:border-red-500'}`}
        type="number"
        min={speedMin}
        max={speedMax}
        step="any"
        value={speedText}
        aria-invalid={!speedParse.ok}
        title={`Average bus speed for this route, without stop dwell time (${speedMin}–${speedMax} ${speedUnit(unitSystem)}). Sets the end-to-end time from the route's length.`}
        onChange={(e) => onSpeedChange(e.target.value)}
      />
      <span>{speedUnit(unitSystem)}</span>
      <span aria-hidden="true" className="text-warm-gray">→</span>
      <label htmlFor="gen-end-to-end">End to end</label>
      <input
        id="gen-end-to-end"
        className={TIN_NUM}
        type="number"
        min={1}
        value={run}
        title="Estimated from the route length at the average speed — adjust if needed"
        onChange={(e) => setRun(Math.max(1, Number(e.target.value) || 0))}
      />
      <span>min</span>
      <span className="basis-full h-0" />
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'explicit'} onChange={() => setMode('explicit')} className="accent-coral" />
        Individual trips <span className="text-warm-gray text-[11.5px]">(needed for vehicle blocking)</span>
      </label>
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'frequency'} onChange={() => setMode('frequency')} className="accent-coral" />
        Frequency-based <span className="text-warm-gray text-[11.5px]">(one trip + frequencies.txt)</span>
      </label>
    </Drawer>
  );
}

/* ---------- ⏱ Set run time ---------- */
export function RuntimeDrawer({
  ctx, currentRun, tripCount, estimateDefaults, onApply, onEstimate, onCancel,
}: {
  ctx: string;
  currentRun: number;
  tripCount: number;
  estimateDefaults: { dwellSec: number; speedFactor: number };
  onApply: (input: { runMin: number; scoped: boolean }) => void;
  /** Estimate mode — async (may hit Map Matching); resolves with a status the
   *  drawer surfaces. On success the orchestrator closes the drawer. */
  onEstimate: (input: { dwellSec: number; speedFactor: number; scoped: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'runtime' | 'estimate'>('runtime');
  const [run, setRun] = useState(currentRun);
  const [scoped, setScoped] = useState(false);
  const [dwell, setDwell] = useState(estimateDefaults.dwellSec);
  const [speed, setSpeed] = useState(estimateDefaults.speedFactor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickMode = (m: 'runtime' | 'estimate') => { if (!busy) { setMode(m); setError(null); } };

  const handleApply = async () => {
    if (mode === 'runtime') { onApply({ runMin: run, scoped }); return; }
    setBusy(true);
    setError(null);
    const res = await onEstimate({ dwellSec: dwell, speedFactor: speed, scoped });
    // On success the drawer unmounts; only need to recover on failure.
    if (!res.ok) { setError(res.error ?? 'Estimate failed.'); setBusy(false); }
  };

  const trips = `${tripCount} trip${tripCount === 1 ? '' : 's'}`;
  const count = error
    ? <span className="text-red-500">{error}</span>
    : mode === 'runtime'
      ? `Current run time ${currentRun} min · re-times ${trips}`
      : `Estimates times for ${trips}`;
  const applyLabel = mode === 'runtime'
    ? `Re-time ${trips}`
    : busy ? 'Estimating…' : `Estimate ${trips}`;

  return (
    <Drawer
      icon="⏱"
      iconClassName="bg-teal-light text-teal"
      title="Set run time"
      sub={mode === 'runtime'
        ? `${ctx} — every trip keeps its own start time; headways stay intact.`
        : `${ctx} — lay times from the road network; every trip keeps its own start time.`}
      count={count}
      applyLabel={applyLabel}
      canApply={!busy && tripCount > 0 && (mode === 'runtime' ? run > 0 : true)}
      onApply={handleApply}
      onCancel={onCancel}
    >
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'runtime'} onChange={() => pickMode('runtime')} disabled={busy} className="accent-coral" />
        Set run time
      </label>
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'estimate'} onChange={() => pickMode('estimate')} disabled={busy} className="accent-coral" />
        Estimate from route geometry
      </label>
      <span className="basis-full h-0" />
      {mode === 'runtime' ? (
        <>
          <span>End to end, this pattern takes</span>
          <input className={TIN_NUM} type="number" min={1} value={run} onChange={(e) => setRun(Math.max(1, Number(e.target.value) || 0))} />
          <span>min</span>
        </>
      ) : (
        <>
          <span>Dwell</span>
          <input className={TIN_NUM} type="number" min={0} value={dwell} disabled={busy} title="Seconds added at each stop for boarding/alighting" onChange={(e) => setDwell(Math.max(0, Number(e.target.value) || 0))} />
          <span>sec/stop · bus runs</span>
          <input className={TIN_NUM} type="number" min={0.1} step={0.1} value={speed} disabled={busy} title="A bus is slower than a car — driving time is multiplied by this factor" onChange={(e) => setSpeed(Math.max(0.1, Number(e.target.value) || 0.1))} />
          <span>× slower than a car</span>
        </>
      )}
      {VR}
      <label className="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer">
        <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} disabled={busy} className="accent-coral" />
        This service day only
      </label>
    </Drawer>
  );
}

/* ---------- ↻ Repeat last trip ---------- */
export function RepeatDrawer({
  lastSec, tripCount, onApply, onCancel,
}: {
  /** Start of the trip Repeat copies (the last TIMED trip), in seconds; null
   *  when no trip in scope has a time. Passed as a number, not a formatted
   *  label, so an overnight start ("01:30 +1d") previews correctly. */
  lastSec: number | null;
  tripCount: number;
  onApply: (input: { headway: number; copies: number }) => void;
  onCancel: () => void;
}) {
  const [head, setHead] = useState(30);
  const [copies, setCopies] = useState(4);
  const lastStart = lastSec == null ? '—' : formatTimeShort(secondsToGtfsTime(lastSec));
  const ok = tripCount > 0 && lastSec != null && head > 0 && copies > 0;
  const range = ok && lastSec != null
    ? `${formatTimeShort(secondsToGtfsTime(lastSec + head * 60))} → ${formatTimeShort(secondsToGtfsTime(lastSec + head * copies * 60))}`
    : '';
  return (
    <Drawer
      icon="↻"
      iconClassName="bg-gold-light text-[#b8860b]"
      title="Repeat last trip"
      sub="Add copies of the last trip, spaced at a set headway."
      count={ok ? `Adds ${copies} trip${copies === 1 ? '' : 's'}${range ? ` · ${range}` : ''}` : '—'}
      applyLabel={`Add ${copies} trip${copies === 1 ? '' : 's'}`}
      canApply={ok}
      onApply={() => onApply({ headway: head, copies })}
      onCancel={onCancel}
    >
      <span>A new trip every</span>
      <input className={TIN_NUM} type="number" min={1} value={head} onChange={(e) => setHead(Math.max(1, Number(e.target.value) || 0))} />
      <span>min,</span>
      <input className={TIN_NUM} type="number" min={1} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 0))} />
      <span>more copies, starting after the {lastStart} trip</span>
    </Drawer>
  );
}

/* ---------- ⏲ Edit frequency windows ---------- */
// Windows hold the typed text while editing; checkFrequencyDrawer normalizes
// (and rejects garbage) for validation and on Apply.
const DEFAULT_WINDOW: FrequencyWindow = { start_time: '06:00', end_time: '22:00', headway_secs: 1800, exact_times: 0 };

export function FrequencyDrawer({
  ctx, tripId, initialWindows, onApply, onCancel,
}: {
  ctx: string;
  tripId: string;
  initialWindows: FrequencyWindow[];
  onApply: (windows: FrequencyWindow[]) => void;
  onCancel: () => void;
}) {
  // Seeded once per mount; the parent keys this drawer on the trip id so
  // switching trips re-seeds instead of carrying one trip's windows to another.
  const [windows, setWindows] = useState<FrequencyWindow[]>(
    () => (initialWindows.length
      ? initialWindows.map((w) => ({ ...w, start_time: frequencyTimeLabel(w.start_time), end_time: frequencyTimeLabel(w.end_time) }))
      : [{ ...DEFAULT_WINDOW }]),
  );
  const check = checkFrequencyDrawer(windows);
  const departures = windowDepartureCount(check.normalized.filter((_, i) => !check.errors[i].badTime));
  const empty = windows.length === 0;

  const setW = (i: number, patch: Partial<FrequencyWindow>) =>
    setWindows((ws) => ws.map((w, k) => (k === i ? { ...w, ...patch } : w)));

  const count = empty
    ? <span className="text-amber-600 font-normal">Removes the frequency — {tripId} becomes a plain single trip.</span>
    : <>→ {departures} departure{departures === 1 ? '' : 's'}{check.overlaps.length > 0 && <span className="text-red-500 font-normal"> · overlapping windows</span>}</>;

  return (
    <Drawer
      icon="⏲"
      iconClassName="bg-teal-light text-teal"
      title="Edit frequency"
      sub={`${ctx} · ${tripId} — headway windows. The trip's stop times stay editable in the grid.`}
      count={count}
      applyLabel={empty ? 'Remove frequency' : 'Apply windows'}
      canApply={check.canApply}
      onApply={() => onApply(check.normalized)}
      onCancel={onCancel}
    >
      {windows.map((w, i) => {
        const err = check.errors[i];
        const overlap = check.overlaps.includes(i);
        const note = err.badTime ? 'enter times like 06:00'
          : err.badHeadway ? 'headway must be > 0'
          : err.badRange ? 'end must be after start'
          : overlap ? 'overlaps another window' : null;
        return (
          <div key={i} className="basis-full flex items-center gap-2 flex-wrap">
            <span>Every</span>
            <input className={TIN_NUM} type="number" min={1} aria-label={`Window ${i + 1} headway minutes`}
              value={headwayMinutesInput(w.headway_secs)}
              onChange={(e) => setW(i, { headway_secs: parseHeadwayMinutes(e.target.value) })} />
            <span>min from</span>
            <input className={TIN_TIME} aria-label={`Window ${i + 1} start`} value={w.start_time} onChange={(e) => setW(i, { start_time: e.target.value })} />
            <span>to</span>
            <input className={TIN_TIME} aria-label={`Window ${i + 1} end`} value={w.end_time} onChange={(e) => setW(i, { end_time: e.target.value })} />
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-[12.5px]">
              <input type="checkbox" checked={w.exact_times === 1} onChange={(e) => setW(i, { exact_times: e.target.checked ? 1 : 0 })} className="accent-coral" />
              Exact times
            </label>
            {note && <span className="text-[11px] text-red-500">{note}</span>}
            <button type="button" onClick={() => setWindows((ws) => ws.filter((_, k) => k !== i))} title="Remove window"
              className="ml-auto w-6 h-6 flex items-center justify-center rounded text-warm-gray hover:text-red-500 hover:bg-red-50 text-base leading-none">×</button>
          </div>
        );
      })}
      <button type="button" onClick={() => setWindows((ws) => [...ws, { ...DEFAULT_WINDOW }])}
        className="basis-full text-left text-[12.5px] font-heading font-bold text-teal hover:text-[#0d7a6f]">+ Add window</button>
    </Drawer>
  );
}

/* ---------- ⇆ Shift selected trips ---------- */

/** What a candidate shift would do, computed by the orchestrator from the
 *  live feed (`planShiftTrips` + `newBlockOverlaps`) as the planner types. */
export interface ShiftPreview {
  ok: boolean;
  error?: string;
  tripCount: number;
  /** frequencies.txt windows that move with their template trips. */
  windowCount: number;
  /** Selected trips that carry a block_id. */
  blockedTripCount: number;
  /** Block overlaps the shift would CREATE (blocks are never reassigned). */
  newOverlaps: { blockId: string; tripA: string; tripB: string }[];
}

const SHIFT_PRESETS = [-15, -10, -5, 5, 10, 15];
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;

export function ShiftDrawer({
  ctx, getPreview, onApply, onCancel,
}: {
  /** e.g. "7 trips selected · Outbound". */
  ctx: string;
  getPreview: (deltaMin: number) => ShiftPreview;
  onApply: (deltaMin: number) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('+10');
  const delta = parseShiftMinutes(text);
  const preview: ShiftPreview | null = useMemo(() => (delta == null ? null : getPreview(delta)), [delta, getPreview]);
  const canApply = !!preview?.ok;
  const n = preview?.tripCount ?? 0;
  const trips = `${n} trip${n === 1 ? '' : 's'}`;

  let count: ReactNode;
  if (delta == null) count = <span className="text-red-500">Enter whole minutes, e.g. +10 or -5.</span>;
  else if (!preview?.ok) count = <span className="text-red-500">{preview?.error ?? '—'}</span>;
  else {
    const parts = [`Moves ${trips} ${delta > 0 ? 'later' : 'earlier'} by ${Math.abs(delta)} min`];
    if (preview.windowCount > 0) parts.push(`${preview.windowCount} frequency window${preview.windowCount === 1 ? '' : 's'} move too`);
    count = parts.join(' · ');
  }

  const overlapNote = preview?.ok && preview.newOverlaps.length > 0 ? (
    <span className="basis-full text-[11.5px] text-red-600">
      ⚠ Creates {preview.newOverlaps.length} block conflict{preview.newOverlaps.length === 1 ? '' : 's'}{' '}
      ({preview.newOverlaps.slice(0, 2).map((o) => `block ${o.blockId}: ${o.tripA} ↔ ${o.tripB}`).join('; ')}
      {preview.newOverlaps.length > 2 ? '; …' : ''}). Block assignments are kept as they are; fix them in the Blocks view (Quick Block, or drag a trip).
    </span>
  ) : preview?.ok && preview.blockedTripCount > 0 ? (
    <span className="basis-full text-[11.5px] text-warm-gray">
      {preview.blockedTripCount} of these trip{preview.blockedTripCount === 1 ? ' is' : 's are'} on a block. Block assignments are kept as they are; check layovers in the Blocks view.
    </span>
  ) : null;

  return (
    <Drawer
      icon="⇆"
      iconClassName="bg-teal-light text-teal"
      title="Shift trips"
      sub={`${ctx} — every arrival and departure moves by the same amount; run times stay intact.`}
      count={count}
      applyLabel={canApply && delta != null ? `Shift ${trips} ${signed(delta)} min` : 'Shift trips'}
      canApply={canApply}
      onApply={() => { if (delta != null) onApply(delta); }}
      onCancel={onCancel}
    >
      <label htmlFor="shift-minutes">Shift by</label>
      <input
        id="shift-minutes"
        autoFocus
        className={`${TIN_NUM} w-[64px] ${delta == null ? 'border-red-400 focus:border-red-500' : ''}`}
        inputMode="numeric"
        value={text}
        aria-invalid={delta == null}
        title="Minutes: positive = later, negative = earlier"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canApply && delta != null) onApply(delta); }}
      />
      <span>min</span>
      {SHIFT_PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => setText(p > 0 ? `+${p}` : String(p))}
          className={`h-6 px-2 rounded border font-heading font-bold text-[11.5px] tabular-nums ${
            delta === p ? 'bg-coral border-coral text-white' : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]'
          }`}
        >
          {signed(p)}
        </button>
      ))}
      {overlapNote}
    </Drawer>
  );
}
