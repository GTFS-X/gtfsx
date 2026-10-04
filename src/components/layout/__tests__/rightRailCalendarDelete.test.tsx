// @vitest-environment jsdom
// S1-14: deleting a calendar that trips still use is refused by the store.
// The RightRail calendar header must then keep the panel open on that
// calendar and show why (role="alert"), instead of closing as if the delete
// happened. Switching to another calendar hides the message, and an unused
// calendar deletes and closes the panel.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { Calendar, Trip } from '../../../types/gtfs';
import { RightRail } from '../RightRail';

const cal = (id: string): Calendar => ({
  service_id: id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
}) as Calendar;
const trip = (id: string): Trip => ({ trip_id: id, route_id: 'R', service_id: 'WK', direction_id: 0 }) as Trip;

describe('RightRail calendar delete (S1-14)', () => {
  beforeEach(() => {
    resetStore({
      calendars: [cal('WK'), cal('SPARE')],
      trips: [trip('t1'), trip('t2')],
      sidebarSection: 'calendar',
      rightRailOpen: true,
      editingCalendarServiceId: 'WK',
    });
  });

  async function deleteCurrent(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTitle('Delete this calendar'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
  }

  it('a refused delete keeps the calendar open and explains why', async () => {
    const user = userEvent.setup();
    render(<RightRail />);
    await deleteCurrent(user);

    expect(store().calendars.map((c) => c.service_id)).toEqual(['WK', 'SPARE']);
    expect(store().editingCalendarServiceId).toBe('WK');
    expect(screen.getByRole('alert')).toHaveTextContent(/used by 2 trips/);
    expect(screen.getByTitle('Delete this calendar')).toBeInTheDocument();
  });

  it('the message is per calendar, and an unused calendar deletes and closes', async () => {
    const user = userEvent.setup();
    render(<RightRail />);
    await deleteCurrent(user);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => store().setEditingCalendarServiceId('SPARE'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await deleteCurrent(user);

    expect(store().calendars.map((c) => c.service_id)).toEqual(['WK']);
    expect(store().editingCalendarServiceId).toBeNull();
  });
});
