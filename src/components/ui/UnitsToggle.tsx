import { useStore } from '../../store';
import type { UnitSystem } from '../../utils/units';
import { Segmented } from './Segmented';

const SYSTEMS: UnitSystem[] = ['imperial', 'metric'];
const LABELS = ['Imperial', 'Metric'];

/** Imperial / Metric picker for distance and speed readouts (issue #76).
 *  Display-only: feed data and calculations are unaffected. */
export function UnitsToggle() {
  const unitSystem = useStore((s) => s.unitSystem);
  const setUnitSystem = useStore((s) => s.setUnitSystem);
  return (
    <Segmented
      value={SYSTEMS.indexOf(unitSystem)}
      onChange={(i) => setUnitSystem(SYSTEMS[i]!)}
      options={LABELS}
      aria-label="Units"
      title="Units for distances and speeds (ft / mi / mph or m / km / km/h)"
    />
  );
}
