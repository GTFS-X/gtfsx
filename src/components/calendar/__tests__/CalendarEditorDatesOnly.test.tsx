// @vitest-environment jsdom
// C2-03: the Calendars list must show calendar_dates-only services as
// "Dates only" cards (CalendarEditor builds its list with serviceOptions over
// calendars AND calendarDates), and opening one keeps it selected.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { Calendar, CalendarDate } from '../../../types/gtfs';
import { CalendarEditor } from '../CalendarEditor';

const wk: Calendar = {
  service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
} as Calendar;
const dated = (date: string): CalendarDate => ({ service_id: 'EVENT', date, exception_type: 1 }) as CalendarDate;

describe('CalendarEditor dates-only services (C2-03)', () => {
  beforeEach(() => resetStore({ calendars: [wk], calendarDates: [dated('20260704'), dated('20261231')] }));

  it('lists a dates-only service as a "Dates only" card and opens it', async () => {
    render(<CalendarEditor />);
    const card = screen.getByText('EVENT').closest('button')!;
    expect(card).toHaveTextContent('Dates only');
    expect(card).toHaveTextContent('2 service dates');

    await userEvent.click(card);
    expect(store().editingCalendarServiceId).toBe('EVENT');
  });
});
