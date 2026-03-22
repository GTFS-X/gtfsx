import React, { useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { formatTimeShort } from '../../utils/time';
import { generateId } from '../../services/idGenerator';

export function TimetableGrid() {
  const {
    selectedRouteId, routes, trips, stopTimes, stops, routeStops, calendars,
    setStopTime, addTrip, duplicateTrip, removeTrip, setStopTimes,
  } = useStore();

  const route = routes.find((r) => r.route_id === selectedRouteId);

  // Get ordered stops for this route (direction 0)
  const orderedStops = useMemo(() => {
    if (!selectedRouteId) return [];
    return routeStops
      .filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === 0)
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as typeof stops;
  }, [selectedRouteId, routeStops, stops]);

  // Get trips for this route
  const routeTrips = useMemo(() => {
    if (!selectedRouteId) return [];
    return trips
      .filter((t) => t.route_id === selectedRouteId)
      .sort((a, b) => {
        const aFirst = stopTimes.find((st) => st.trip_id === a.trip_id);
        const bFirst = stopTimes.find((st) => st.trip_id === b.trip_id);
        return (aFirst?.arrival_time || '').localeCompare(bFirst?.arrival_time || '');
      });
  }, [selectedRouteId, trips, stopTimes]);

  const handleTimeChange = useCallback((tripId: string, stopId: string, seq: number, value: string) => {
    // Normalize: accept H:MM and convert to HH:MM:SS
    let time = value;
    if (/^\d{1,2}:\d{2}$/.test(time)) time += ':00';
    setStopTime(tripId, stopId, seq, { arrival_time: time, departure_time: time });
  }, [setStopTime]);

  const handleAddTrip = () => {
    if (!selectedRouteId) return;
    const tripId = generateId('trip');
    addTrip({
      trip_id: tripId,
      route_id: selectedRouteId,
      service_id: calendars[0]?.service_id || '',
      direction_id: 0,
      trip_headsign: route?.route_short_name || '',
      shape_id: trips.find((t) => t.route_id === selectedRouteId)?.shape_id,
    });
  };

  const handleDuplicate = (tripId: string) => {
    const newId = generateId('trip');
    duplicateTrip(tripId, newId, 60); // 60 min offset
  };

  if (!route) {
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        Select a route to view its timetable
      </div>
    );
  }

  if (orderedStops.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        Add stops to this route first
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="flex items-center gap-3 mb-2 px-2">
        <span className="text-xs text-warm-gray">
          {route.route_short_name || route.route_long_name} — {routeTrips.length} trips
        </span>
        <div className="flex-1" />
        <button
          onClick={handleAddTrip}
          className="px-3 py-1 border-2 border-dashed border-sand rounded-md text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors"
        >
          + Add Trip
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[600px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand z-10">
                Trip
              </th>
              {orderedStops.map((stop) => (
                <th
                  key={stop.stop_id}
                  className="px-2 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand whitespace-nowrap"
                >
                  {stop.stop_name.length > 20 ? stop.stop_name.slice(0, 18) + '…' : stop.stop_name}
                </th>
              ))}
              <th className="px-2 py-2 border-b border-sand" />
            </tr>
          </thead>
          <tbody>
            {routeTrips.map((trip) => (
              <tr key={trip.trip_id} className="hover:bg-cream">
                <td className="sticky left-0 bg-white px-3 py-1.5 font-semibold text-dark-brown border-b border-[#F5F0EB] z-10">
                  {trip.trip_id.length > 10 ? trip.trip_id.slice(0, 8) + '…' : trip.trip_id}
                </td>
                {orderedStops.map((stop, seq) => {
                  const st = stopTimes.find(
                    (s) => s.trip_id === trip.trip_id && s.stop_id === stop.stop_id
                  );
                  return (
                    <td key={stop.stop_id} className="px-1 py-0.5 border-b border-[#F5F0EB]">
                      <input
                        value={st ? formatTimeShort(st.arrival_time) : ''}
                        onChange={(e) => handleTimeChange(trip.trip_id, stop.stop_id, seq, e.target.value)}
                        placeholder="—"
                        className="w-14 px-1.5 py-1 text-xs rounded border border-transparent hover:border-sand focus:border-coral focus:outline-none bg-transparent tabular-nums"
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 border-b border-[#F5F0EB]">
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleDuplicate(trip.trip_id)}
                      title="Duplicate (+60 min)"
                      className="text-warm-gray hover:text-coral text-[11px]"
                    >
                      ⧉
                    </button>
                    <button
                      onClick={() => removeTrip(trip.trip_id)}
                      title="Delete trip"
                      className="text-warm-gray hover:text-red-500 text-[11px]"
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
