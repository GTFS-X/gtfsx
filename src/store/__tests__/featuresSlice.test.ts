// Per-feed advanced-feature gating: defaults, data-driven auto-enable, explicit
// toggles, the in-use guard, data clearing, and the demand-response validation
// nudge. See src/store/featuresSlice.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { featureEnabled, featureHasData, clearFeatureData } from '../featuresSlice';
import { runValidation } from '../../services/validation';

function reset() {
  const s = useStore.getState();
  s.setFeatureSettings({});
  s.setFrequencies([]);
  s.setTransfers([]);
  s.setLevels([]);
  s.setPathways([]);
  s.setFlexZones([]);
  s.setTrips([]);
  s.setRoutes([]);
  s.setStopTimes([]);
  // Clear every Fares v2 file so the faresV2 auto-on-when-data rule doesn't
  // leak across tests (it enables on any populated v2 file).
  s.setFareAreas([]);
  s.setStopAreas([]);
  s.setFareNetworks([]);
  s.setRouteNetworks([]);
  s.setTimeframes([]);
  s.setRiderCategories([]);
  s.setFareMedia([]);
  s.setFareProducts([]);
  s.setFareLegRules([]);
  s.setFareTransferRules([]);
  s.setCurrentPublication(null);
}
beforeEach(reset);
afterEach(reset);

describe('feature defaults', () => {
  it('demand response is on by default; the rest are off', () => {
    const s = useStore.getState();
    expect(featureEnabled(s, 'demandResponse')).toBe(true);
    for (const f of ['transfers', 'frequencies', 'stations', 'blocks', 'serviceAlerts', 'faresV2', 'continuousStops'] as const) {
      expect(featureEnabled(s, f)).toBe(false);
    }
  });

  it('service alerts default to on once the feed is published', () => {
    expect(featureEnabled(useStore.getState(), 'serviceAlerts')).toBe(false);
    useStore.getState().setCurrentPublication({ slug: 's', publishedAt: 1 } as never);
    expect(featureEnabled(useStore.getState(), 'serviceAlerts')).toBe(true);
    // An explicit off still wins over the published default.
    useStore.getState().setFeatureSetting('serviceAlerts', false);
    expect(featureEnabled(useStore.getState(), 'serviceAlerts')).toBe(false);
  });
});

describe('data-driven auto-enable', () => {
  it('a feature with data is enabled even without an explicit toggle', () => {
    useStore.getState().setFrequencies([{ trip_id: 't1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 } as never]);
    const s = useStore.getState();
    expect(featureHasData(s, 'frequencies')).toBe(true);
    expect(featureEnabled(s, 'frequencies')).toBe(true);
  });

  it('blocks stay hidden by default even when the feed has block_id (too niche to auto-surface)', () => {
    useStore.getState().setTrips([{ trip_id: 't1', route_id: 'r1', service_id: 's1', block_id: 'b1' } as never]);
    const s = useStore.getState();
    expect(featureHasData(s, 'blocks')).toBe(true);
    expect(featureEnabled(s, 'blocks')).toBe(false);
  });

  it('blocks show once explicitly turned on', () => {
    useStore.getState().setTrips([{ trip_id: 't1', route_id: 'r1', service_id: 's1', block_id: 'b1' } as never]);
    useStore.getState().setFeatureSetting('blocks', true);
    expect(featureEnabled(useStore.getState(), 'blocks')).toBe(true);
  });

  it('continuousStops auto-enables when a route carries continuous_pickup/drop-off', () => {
    useStore.getState().setRoutes([
      { route_id: 'r1', route_short_name: '1', route_type: 3, continuous_pickup: 0 } as never,
    ]);
    const s = useStore.getState();
    expect(featureHasData(s, 'continuousStops')).toBe(true);
    expect(featureEnabled(s, 'continuousStops')).toBe(true);
  });

  it('continuousStops auto-enables when a stop_time carries continuous_pickup/drop-off', () => {
    useStore.getState().setStopTimes([
      { trip_id: 't1', stop_id: 's1', stop_sequence: 1, continuous_drop_off: 3 } as never,
    ]);
    const s = useStore.getState();
    expect(featureHasData(s, 'continuousStops')).toBe(true);
    expect(featureEnabled(s, 'continuousStops')).toBe(true);
  });

  it('continuousStops stays off when no route/stop_time uses it', () => {
    useStore.getState().setRoutes([{ route_id: 'r1', route_short_name: '1', route_type: 3 } as never]);
    useStore.getState().setStopTimes([{ trip_id: 't1', stop_id: 's1', stop_sequence: 1 } as never]);
    const s = useStore.getState();
    expect(featureHasData(s, 'continuousStops')).toBe(false);
    expect(featureEnabled(s, 'continuousStops')).toBe(false);
  });
});

describe('explicit toggles + in-use guard', () => {
  it('explicit on shows a feature with no data', () => {
    useStore.getState().setFeatureSetting('frequencies', true);
    expect(featureEnabled(useStore.getState(), 'frequencies')).toBe(true);
  });

  it('demand response can be turned off when there is no flex data', () => {
    useStore.getState().setFeatureSetting('demandResponse', false);
    expect(featureEnabled(useStore.getState(), 'demandResponse')).toBe(false);
  });

  it('an explicit off hides the feature but keeps its data (hide, not delete)', () => {
    const s = useStore.getState();
    s.setFlexZones([{ id: 'z1' } as never]);
    s.setFeatureSetting('demandResponse', false);
    expect(featureEnabled(useStore.getState(), 'demandResponse')).toBe(false);
    // Hiding preserves the data — it still exports; only delete clears it.
    expect(useStore.getState().flexZones.length).toBe(1);
  });
});

describe('clearFeatureData', () => {
  it('clears the rows a feature owns', () => {
    const s = useStore.getState();
    s.setFrequencies([{ trip_id: 't1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 } as never]);
    clearFeatureData(useStore.getState(), 'frequencies');
    expect(useStore.getState().frequencies.length).toBe(0);
  });

  it('strips block_id from trips (blocks has no file)', () => {
    const s = useStore.getState();
    s.setTrips([{ trip_id: 't1', route_id: 'r1', service_id: 's1', block_id: 'b1' } as never]);
    clearFeatureData(useStore.getState(), 'blocks');
    expect(useStore.getState().trips.every((t) => !t.block_id)).toBe(true);
  });

  it('continuousStops clears continuous_pickup/drop-off on both routes and stop_times', () => {
    const s = useStore.getState();
    s.setRoutes([
      { route_id: 'r1', route_short_name: '1', route_type: 3, continuous_pickup: 0, continuous_drop_off: 2 } as never,
    ]);
    s.setStopTimes([
      { trip_id: 't1', stop_id: 's1', stop_sequence: 1, continuous_pickup: 3 } as never,
    ]);
    clearFeatureData(useStore.getState(), 'continuousStops');
    const after = useStore.getState();
    expect(after.routes.every((r) => r.continuous_pickup === undefined && r.continuous_drop_off === undefined)).toBe(true);
    expect(after.stopTimes.every((st) => st.continuous_pickup === undefined && st.continuous_drop_off === undefined)).toBe(true);
    // featureHasData reflects the cleared state.
    expect(featureHasData(useStore.getState(), 'continuousStops')).toBe(false);
  });
});

describe('demand-response validation nudge', () => {
  const flexNudge = (msgs: { message: string }[]) =>
    msgs.some((m) => m.message.includes('Demand-response service is on but no GTFS-Flex zones'));

  it('warns when demand-response is on and there are no flex zones', () => {
    expect(flexNudge(runValidation(useStore.getState()))).toBe(true);
  });

  it('does not warn once flex zones exist', () => {
    useStore.getState().setFlexZones([{ id: 'z1' } as never]);
    expect(flexNudge(runValidation(useStore.getState()))).toBe(false);
  });

  it('does not warn when demand-response is turned off', () => {
    useStore.getState().setFeatureSetting('demandResponse', false);
    expect(flexNudge(runValidation(useStore.getState()))).toBe(false);
  });
});
