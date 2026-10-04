

const DAYS = [
  { key: 'monday', label: 'M', name: 'Monday' },
  { key: 'tuesday', label: 'T', name: 'Tuesday' },
  { key: 'wednesday', label: 'W', name: 'Wednesday' },
  { key: 'thursday', label: 'Th', name: 'Thursday' },
  { key: 'friday', label: 'F', name: 'Friday' },
  { key: 'saturday', label: 'Sa', name: 'Saturday' },
  { key: 'sunday', label: 'Su', name: 'Sunday' },
] as const;

interface DayToggleProps {
  values: Record<string, 0 | 1>;
  onChange: (day: string, value: 0 | 1) => void;
}

export function DayToggle({ values, onChange }: DayToggleProps) {
  return (
    <div className="flex gap-1">
      {DAYS.map(({ key, label, name }) => {
        const active = values[key] === 1;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            aria-label={name}
            onClick={() => onChange(key, active ? 0 : 1)}
            className={`w-9 h-9 rounded-full text-xs font-bold transition-colors
              ${active
                ? 'bg-coral text-white'
                : 'bg-sand text-warm-gray hover:bg-coral-light hover:text-coral'
              }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
