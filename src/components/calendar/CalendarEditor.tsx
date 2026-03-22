import React, { useState } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { DayToggle } from '../ui/DayToggle';
import { FormField } from '../ui/FormField';
import { generateId } from '../../services/idGenerator';
import type { Calendar, CalendarDate } from '../../types/gtfs';
import { format, parse } from 'date-fns';

function formatGtfsDate(d: string): string {
  if (!d || d.length !== 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function toGtfsDate(d: string): string {
  return d.replace(/-/g, '');
}

export function CalendarEditor() {
  const {
    calendars, addCalendar, updateCalendar, removeCalendar,
    calendarDates, addCalendarDate, removeCalendarDate,
  } = useStore();
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const handleAdd = () => {
    const id = generateId('service');
    addCalendar({
      service_id: id,
      monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
      saturday: 0, sunday: 0,
      start_date: format(new Date(), 'yyyyMMdd'),
      end_date: '20991231',
      _description: 'Weekdays',
    });
    setSelectedServiceId(id);
  };

  if (calendars.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title="No service patterns"
        description="Define when your transit service operates."
        actionLabel="Add Service Pattern"
        onAction={handleAdd}
      />
    );
  }

  const selected = selectedServiceId ? calendars.find((c) => c.service_id === selectedServiceId) : null;
  const selectedDates = selectedServiceId ? calendarDates.filter((cd) => cd.service_id === selectedServiceId) : [];

  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Service Patterns</h3>

      {/* Pattern list */}
      <div className="flex flex-col gap-2 mb-3">
        {calendars.map((cal) => (
          <button
            key={cal.service_id}
            onClick={() => setSelectedServiceId(cal.service_id)}
            className={`text-left p-3 rounded-lg transition-colors
              ${selectedServiceId === cal.service_id ? 'bg-coral-light' : 'bg-cream hover:bg-sand'}`}
          >
            <div className="flex justify-between items-center mb-1">
              <span className="font-heading font-bold text-sm text-dark-brown">
                {cal._description || cal.service_id}
              </span>
              <span className="text-[11px] text-teal font-semibold">Active</span>
            </div>
            <div className="flex gap-1">
              {['M','T','W','Th','F','Sa','Su'].map((d, i) => {
                const days = [cal.monday, cal.tuesday, cal.wednesday, cal.thursday, cal.friday, cal.saturday, cal.sunday];
                return (
                  <span key={d} className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center
                    ${days[i] ? 'bg-coral text-white' : 'bg-sand text-warm-gray'}`}>
                    {d}
                  </span>
                );
              })}
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={handleAdd}
        className="w-full flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors"
      >
        + Add Service Pattern
      </button>

      {/* Selected pattern editor */}
      {selected && (
        <div className="mt-4 pt-4 border-t border-sand">
          <FormField
            label="Description"
            value={selected._description || ''}
            onChange={(v) => updateCalendar(selected.service_id, { _description: v })}
            placeholder="e.g., Weekdays"
          />

          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
            Operating Days
          </label>
          <DayToggle
            values={{
              monday: selected.monday,
              tuesday: selected.tuesday,
              wednesday: selected.wednesday,
              thursday: selected.thursday,
              friday: selected.friday,
              saturday: selected.saturday,
              sunday: selected.sunday,
            }}
            onChange={(day, value) => updateCalendar(selected.service_id, { [day]: value } as any)}
          />

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">Start Date</label>
              <input
                type="date"
                value={formatGtfsDate(selected.start_date)}
                onChange={(e) => updateCalendar(selected.service_id, { start_date: toGtfsDate(e.target.value) })}
                className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">End Date</label>
              <input
                type="date"
                value={formatGtfsDate(selected.end_date)}
                onChange={(e) => updateCalendar(selected.service_id, { end_date: toGtfsDate(e.target.value) })}
                className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
              />
            </div>
          </div>

          {/* Calendar Dates (Exceptions) */}
          <div className="mt-4">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
              Exceptions (Holidays)
            </label>
            {selectedDates.map((cd) => (
              <div key={cd.date} className="flex items-center gap-2 mb-1.5">
                <span className="text-sm flex-1">{formatGtfsDate(cd.date)}</span>
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded
                  ${cd.exception_type === 2 ? 'bg-red-100 text-red-700' : 'bg-teal-light text-teal'}`}>
                  {cd.exception_type === 2 ? 'No Service' : 'Added'}
                </span>
                <button
                  onClick={() => removeCalendarDate(selected.service_id, cd.date)}
                  className="text-warm-gray hover:text-red-500 text-sm"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input
                type="date"
                id="exception-date"
                className="flex-1 px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
              />
              <button
                onClick={() => {
                  const input = document.getElementById('exception-date') as HTMLInputElement;
                  if (input.value) {
                    addCalendarDate({
                      service_id: selected.service_id,
                      date: toGtfsDate(input.value),
                      exception_type: 2,
                    });
                    input.value = '';
                  }
                }}
                className="px-3 py-1.5 bg-sand rounded-lg text-xs font-semibold text-brown hover:bg-coral-light hover:text-coral transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          <button
            onClick={() => {
              removeCalendar(selected.service_id);
              setSelectedServiceId(null);
            }}
            className="mt-4 text-xs text-red-400 hover:text-red-600"
          >
            Delete this service pattern
          </button>
        </div>
      )}
    </div>
  );
}
