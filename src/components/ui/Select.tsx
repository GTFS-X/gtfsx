interface SelectOption {
  id: string;
  name: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  title?: string;
  'aria-label'?: string;
  className?: string;
}

/** Styled dropdown (`.sel`) — the toolbar's route / service / pattern pickers.
 *  Native `<select>` with the app's chevron and warm-theme chrome. */
export function Select({ value, onChange, options, title, className = '', ...aria }: SelectProps) {
  return (
    <span className="relative inline-flex items-center shrink-0">
      <select
        value={value}
        title={title}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none h-[30px] pl-2.5 pr-7 rounded-md border border-sand bg-white shadow-sm font-heading font-bold text-xs text-dark-brown cursor-pointer hover:border-coral focus:outline-none focus:border-coral ${className}`}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 text-warm-gray"
        width="10"
        height="6"
        viewBox="0 0 10 6"
        fill="none"
        aria-hidden="true"
      >
        <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}
