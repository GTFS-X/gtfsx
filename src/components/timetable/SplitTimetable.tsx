import { useState } from 'react';
import { useStore } from '../../store';
import { computeShapePatterns } from '../ui/shapePatterns';
import { TimetableGrid, type TimetableScope } from './TimetableGrid';

/** Split-view container for the timetable. The left pane is the normal,
 *  global-backed timetable (it stays synced with the map highlight and the
 *  cross-panel "View timetable" handlers); the right pane keeps its own
 *  route / direction / shape / service selection in local state so the two
 *  schedules can be read side by side. The common case — and the default the
 *  right pane opens into — is the same route's opposite direction, so you land
 *  straight on an outbound | inbound comparison to line up arrival/departure
 *  times. Stop-time edits in either pane write through the same trip-keyed store
 *  actions, so both panes stay editable and live-update together. */
export function SplitTimetable() {
  // Lazy one-time default for the right pane: same route as the main pane, but
  // the opposite direction's shape so it opens into outbound | inbound.
  const [paneB, setPaneB] = useState<{
    routeId: string | null;
    directionId: 0 | 1;
    serviceId: string | null;
    shapeId: string | null;
  }>(() => {
    const s = useStore.getState();
    const routeId = s.selectedRouteId;
    const patterns = computeShapePatterns(routeId, s.trips, s.routeStops);
    const other =
      patterns.find((p) => p.directionId !== s.timetableDirectionId) ??
      patterns[1] ??
      patterns[0];
    return {
      routeId,
      directionId: (other?.directionId ?? (s.timetableDirectionId === 0 ? 1 : 0)) as 0 | 1,
      serviceId: s.timetableServiceId,
      shapeId: other?.shapeId ?? null,
    };
  });

  const scopeB: TimetableScope = {
    routeId: paneB.routeId,
    // Changing the right pane's route clears its shape so the grid re-picks the
    // first pattern of the new route (matching the main pane's behaviour).
    setRouteId: (id) => setPaneB((p) => ({ ...p, routeId: id, shapeId: null })),
    directionId: paneB.directionId,
    setDirectionId: (d) => setPaneB((p) => ({ ...p, directionId: d })),
    serviceId: paneB.serviceId,
    setServiceId: (id) => setPaneB((p) => ({ ...p, serviceId: id })),
    shapeId: paneB.shapeId,
    setShapeId: (id) => setPaneB((p) => ({ ...p, shapeId: id })),
  };

  return (
    <div className="flex-1 min-h-0 flex divide-x-2 divide-sand">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <TimetableGrid />
      </div>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <TimetableGrid scope={scopeB} />
      </div>
    </div>
  );
}
