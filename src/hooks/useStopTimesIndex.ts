import { useMemo } from 'react';
import { useStore } from '../store';
import type { StopTime } from '../types/gtfs';

export interface StopTimesIndex {
  byTrip: Map<string, StopTime[]>;
  byStop: Map<string, StopTime[]>;
}

/** Build lookup indexes for the stopTimes array.
 *  Consumers use this instead of .find()/.filter() on the raw 400K+ array. */
export function buildStopTimesIndex(stopTimes: StopTime[]): StopTimesIndex {
  const byTrip = new Map<string, StopTime[]>();
  const byStop = new Map<string, StopTime[]>();

  for (const st of stopTimes) {
    let tripArr = byTrip.get(st.trip_id);
    if (!tripArr) { tripArr = []; byTrip.set(st.trip_id, tripArr); }
    tripArr.push(st);

    let stopArr = byStop.get(st.stop_id);
    if (!stopArr) { stopArr = []; byStop.set(st.stop_id, stopArr); }
    stopArr.push(st);
  }

  return { byTrip, byStop };
}

/** React hook: memoizes the index so it only rebuilds when stopTimes changes. */
export function useStopTimesIndex(): StopTimesIndex {
  const stopTimes = useStore((s) => s.stopTimes);
  return useMemo(() => buildStopTimesIndex(stopTimes), [stopTimes]);
}
