// @vitest-environment jsdom
// Configurable average speed for run-time estimates (Generate trips drawer):
// the speed field's unit handling, the live end-to-end recalculation, and the
// grid flow that threads the speed into generated stop_times and remembers it
// on the route (UI-only `_avg_speed_mph`) in the same undo step.
import '../../../test-utils/dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import { undo } from '../../../store/history';
import type { Calendar, Route, RouteStop, Shape, Stop, Trip } from '../../../types/gtfs';
import { RouteShapesTab } from '../../routes/RouteShapesTab';
import { gtfsTimeToSeconds } from '../../../utils/time';
import { TimetableGrid } from '../TimetableGrid';
import { GenerateDrawer, type GenerateInput } from '../TimetableDrawers';
import { avgSpeedBounds, formatAvgSpeedInput, parseAvgSpeedInput } from '../avgSpeedInput';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe('avgSpeedInput helpers', () => {
  it('formats mph in the display unit', () => {
    expect(formatAvgSpeedInput(20, 'imperial')).toBe('20');
    expect(formatAvgSpeedInput(20, 'metric')).toBe('32.2');
    expect(formatAvgSpeedInput(11, 'imperial')).toBe('11');
  });
  it('parses the display unit back to mph', () => {
    expect(parseAvgSpeedInput('11', 'imperial')).toEqual({ ok: true, mph: 11 });
    const km = parseAvgSpeedInput('50', 'metric');
    expect(km.ok).toBe(true);
    if (km.ok) expect(km.mph).toBeCloseTo(31.07, 2);
  });
  it('enforces a 3–80 mph range (5–128 km/h)', () => {
    expect(avgSpeedBounds('imperial')).toEqual({ min: 3, max: 80 });
    expect(avgSpeedBounds('metric')).toEqual({ min: 5, max: 128 });
    expect(parseAvgSpeedInput('2', 'imperial').ok).toBe(false);
    expect(parseAvgSpeedInput('81', 'imperial').ok).toBe(false);
    expect(parseAvgSpeedInput('', 'imperial').ok).toBe(false);
    expect(parseAvgSpeedInput('abc', 'imperial').ok).toBe(false);
    expect(parseAvgSpeedInput('4', 'metric').ok).toBe(false);
    expect(parseAvgSpeedInput('5', 'metric').ok).toBe(true);
    const err = parseAvgSpeedInput('200', 'metric');
    expect(err.ok === false && err.error).toBe('Average speed must be between 5 and 128 km/h.');
  });
});

/** A pattern 12 minutes long at 20 mph: minutes = 240 / mph. */
const estimateRunMin = (mph: number) => Math.round(240 / mph);
const okPreview = () => ({ ok: true, tripCount: 33 });

describe('GenerateDrawer average speed', () => {
  it('recalculates end-to-end live (20 → 10 mph doubles it) and hands the speed up', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(i: GenerateInput) => void>();
    render(
      <GenerateDrawer ctx="10" initialSpeedMph={20} unitSystem="imperial" estimateRunMin={estimateRunMin}
        getPreview={okPreview} onApply={onApply} onCancel={() => {}} />,
    );
    const speed = screen.getByLabelText('Average speed');
    const run = screen.getByLabelText('End to end');
    expect(speed).toHaveValue(20);
    expect(screen.getByText('mph')).toBeInTheDocument();
    expect(run).toHaveValue(12);

    await user.clear(speed);
    await user.type(speed, '10');
    expect(run).toHaveValue(24);

    await user.click(screen.getByRole('button', { name: /Generate 33 trips/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ avgSpeedMph: 10, runSecs: 24 * 60 });
  });

  it('starts from the route\'s remembered speed', () => {
    render(
      <GenerateDrawer ctx="10" initialSpeedMph={12} unitSystem="imperial" estimateRunMin={estimateRunMin}
        getPreview={okPreview} onApply={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByLabelText('Average speed')).toHaveValue(12);
    expect(screen.getByLabelText('End to end')).toHaveValue(20);
  });

  it('shows and accepts km/h under the metric preference', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(i: GenerateInput) => void>();
    render(
      <GenerateDrawer ctx="10" initialSpeedMph={20} unitSystem="metric" estimateRunMin={estimateRunMin}
        getPreview={okPreview} onApply={onApply} onCancel={() => {}} />,
    );
    const speed = screen.getByLabelText('Average speed');
    expect(speed).toHaveValue(32.2);
    expect(screen.getByText('km/h')).toBeInTheDocument();
    await user.clear(speed);
    await user.type(speed, '16.1'); // ≈ 10 mph
    expect(screen.getByLabelText('End to end')).toHaveValue(24);
    await user.click(screen.getByRole('button', { name: /Generate 33 trips/ }));
    expect(onApply.mock.calls[0][0].avgSpeedMph).toBeCloseTo(10.004, 2);
  });

  it('flags an out-of-range speed and disables Generate', async () => {
    const user = userEvent.setup();
    render(
      <GenerateDrawer ctx="10" initialSpeedMph={20} unitSystem="imperial" estimateRunMin={estimateRunMin}
        getPreview={okPreview} onApply={() => {}} onCancel={() => {}} />,
    );
    const speed = screen.getByLabelText('Average speed');
    await user.clear(speed);
    await user.type(speed, '200');
    expect(screen.getByText('Average speed must be between 3 and 80 mph.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate 33 trips/ })).toBeDisabled();
    expect(screen.getByLabelText('End to end')).toHaveValue(12); // last good estimate kept
  });
});

describe('TimetableGrid → Generate with a custom speed', () => {
  const route: Route = { route_id: 'R', route_short_name: '10', route_long_name: 'Ten', route_type: 3 } as Route;
  const stop = (id: string, lat: number): Stop =>
    ({ stop_id: id, stop_name: `Stop ${id}`, stop_lat: lat, stop_lon: -111, location_type: 0 }) as Stop;
  const rs = (stop_id: string, seq: number): RouteStop =>
    ({ route_id: 'R', stop_id, direction_id: 0, stop_sequence: seq }) as RouteStop;
  const wk: Calendar = {
    service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
  } as Calendar;

  it('generated stop_times use the speed, which is remembered on the route and undone with it', async () => {
    resetStore({
      routes: [route],
      // ~11.1 km straight line A→C: ≈ 21 min at 20 mph, ≈ 41 min at 10 mph.
      stops: [stop('A', 45), stop('B', 45.05), stop('C', 45.1)],
      routeStops: [rs('A', 1), rs('B', 2), rs('C', 3)],
      trips: [],
      stopTimes: [],
      calendars: [wk],
      calendarDates: [],
      selectedRouteId: 'R',
    });
    store().markSaved();
    const user = userEvent.setup();
    render(<TimetableGrid />);

    await user.click(screen.getAllByRole('button', { name: /Generate trips/ })[0]);
    const speed = screen.getByLabelText('Average speed');
    const run = screen.getByLabelText('End to end');
    const at20 = Number((run as HTMLInputElement).value);
    expect(at20).toBeGreaterThanOrEqual(20);
    expect(at20).toBeLessThanOrEqual(22);

    await user.clear(speed);
    await user.type(speed, '10');
    const at10 = Number((run as HTMLInputElement).value);
    expect(Math.abs(at10 - 2 * at20)).toBeLessThanOrEqual(1);

    await user.click(screen.getByRole('button', { name: /^Generate \d+ trips$/ }));
    await act(async () => {});

    const s = store();
    expect(s.trips.length).toBeGreaterThan(0);
    const first = s.stopTimes
      .filter((x) => x.trip_id === s.trips[0].trip_id)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    const span = gtfsTimeToSeconds(first[first.length - 1].arrival_time!) - gtfsTimeToSeconds(first[0].departure_time!);
    expect(span).toBe(at10 * 60);
    expect(s.routes[0]._avg_speed_mph).toBe(10);

    act(() => { undo(); });
    expect(store().trips).toHaveLength(0);
    expect(store().routes[0]._avg_speed_mph).toBeUndefined();
  });
});

describe('Shapes tab runtime readout uses the route speed', () => {
  // ~0.1° of latitude ≈ 11.1 km ≈ 6.9 mi.
  const shape: Shape = {
    shape_id: 'SH',
    points: [
      { shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0 },
      { shape_pt_lat: 45.1, shape_pt_lon: -111, shape_pt_sequence: 1 },
    ],
  } as Shape;
  const seedShapes = (avg?: number, unitSystem: 'imperial' | 'metric' = 'imperial') => resetStore({
    routes: [{ route_id: 'R', route_short_name: '10', route_long_name: 'Ten', route_type: 3, _avg_speed_mph: avg } as Route],
    stops: [],
    shapes: [shape],
    routeStops: [],
    trips: [{ trip_id: 'T1', route_id: 'R', service_id: 'WK', direction_id: 0, shape_id: 'SH' } as Trip],
    editingRouteId: 'R',
    selectedRouteId: 'R',
    unitSystem,
  });

  it('labels the default estimate "@ 20 mph"', () => {
    seedShapes();
    render(<RouteShapesTab />);
    expect(screen.getByText(/6\.9 mi · ≈ 21 mins @ 20 mph/)).toBeInTheDocument();
  });

  it('uses a remembered 10 mph (twice as long), in km/h under metric', () => {
    seedShapes(10, 'metric');
    render(<RouteShapesTab />);
    expect(screen.getByText(/11\.1 km · ≈ 41 mins @ 16 km\/h/)).toBeInTheDocument();
  });
});
