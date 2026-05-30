import { LevelsEditor } from './LevelsEditor';
import { PathwaysEditor } from './PathwaysEditor';

/**
 * "Stations" panel — the home for multi-level station modeling (#13).
 * Levels (floors) on top, pathways (in-station connections) below. Stops are
 * placed on a level via the stop editor's Level selector.
 */
export function StationsPanel() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-warm-gray">
        Model multi-level stations: define <strong>levels</strong> (floors), assign a stop to a
        level in the stop editor, then add <strong>pathways</strong> (walkways, stairs, elevators)
        so trip planners can route riders between platforms.
      </p>

      <section>
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-2 pb-1 border-b border-sand">
          Levels
        </h3>
        <LevelsEditor />
      </section>

      <section>
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-2 pb-1 border-b border-sand">
          Pathways
        </h3>
        <PathwaysEditor />
      </section>
    </div>
  );
}
