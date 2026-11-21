import { useState } from 'react';
import { useStore } from '../../store';
import { WHEELCHAIR_ACCESSIBLE } from '../../utils/constants';
import { summarizeTripWheelchair } from './tripWheelchair';

type Value = 0 | 1 | 2;
type Scope = 'route' | 'feed';

const OPTIONS: { v: Value; label: string }[] = [
  { v: 1, label: WHEELCHAIR_ACCESSIBLE[1] },
  { v: 2, label: WHEELCHAIR_ACCESSIBLE[2] },
  { v: 0, label: WHEELCHAIR_ACCESSIBLE[0] },
];

/**
 * Bulk-set trips.wheelchair_accessible for every trip on one route or in the
 * whole feed ("all buses accessible"). Mirrors the stop wheelchair fill picker
 * (Validation panel): choose a value, then apply. Unlike the stop fill, this
 * overwrites every trip in scope, since the usual case is one fleet-wide fact.
 * One store update, so Undo reverses the whole set.
 */
export function TripWheelchairBulk({ routeId }: { routeId: string }) {
  const trips = useStore((s) => s.trips);
  const setTripsWheelchairAccessible = useStore((s) => s.setTripsWheelchairAccessible);
  const [value, setValue] = useState<Value>(1);
  const [scope, setScope] = useState<Scope>('route');
  const [done, setDone] = useState<string | null>(null);

  const routeTrips = trips.filter((t) => t.route_id === routeId);
  const inScope = scope === 'route' ? routeTrips : trips;
  const summary = summarizeTripWheelchair(routeTrips);
  const scopeCount = inScope.length;

  const apply = () => {
    const changed = setTripsWheelchairAccessible(
      scope === 'route' ? routeTrips.map((t) => t.trip_id) : 'all',
      value,
    );
    const label = WHEELCHAIR_ACCESSIBLE[value].toLowerCase();
    setDone(changed > 0
      ? `Marked ${changed} trip${changed === 1 ? '' : 's'} as ${label}. Undo reverses this.`
      : `All ${scopeCount} trip${scopeCount === 1 ? ' was' : 's were'} already ${label}.`);
  };

  return (
    <div className="rounded-lg border border-sand p-3 mb-3">
      <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        Wheelchair access
      </p>
      <p className="text-[12px] text-dark-brown mb-2">
        On this route: {summary.accessible} accessible, {summary.notAccessible} not accessible,{' '}
        {summary.unknown} unknown.
      </p>
      <p className="text-[11px] text-warm-gray mb-1">
        Can a rider using a wheelchair board the vehicle? Set every trip on
      </p>
      <div className="flex gap-1 mb-2" role="radiogroup" aria-label="Which trips to set">
        {(['route', 'feed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={scope === s}
            onClick={() => { setScope(s); setDone(null); }}
            className={`flex-1 px-1.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
              scope === s
                ? 'border-teal bg-teal-light text-teal'
                : 'border-sand text-warm-gray hover:border-teal/50'
            }`}
          >
            {s === 'route' ? `This route (${routeTrips.length})` : `Whole feed (${trips.length})`}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-warm-gray mb-1">to</p>
      <div className="flex gap-1 mb-2" role="radiogroup" aria-label="Wheelchair access value">
        {OPTIONS.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            onClick={() => { setValue(o.v); setDone(null); }}
            className={`flex-1 px-1.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
              value === o.v
                ? 'border-teal bg-teal-light text-teal'
                : 'border-sand text-warm-gray hover:border-teal/50'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={apply}
        disabled={scopeCount === 0}
        className="w-full px-3 py-1.5 rounded-md text-[12px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {`Mark ${scopeCount} trip${scopeCount === 1 ? '' : 's'} ${WHEELCHAIR_ACCESSIBLE[value].toLowerCase()}`}
      </button>
      {done && <p className="text-[11px] text-teal mt-1.5" role="status">{done}</p>}
    </div>
  );
}
