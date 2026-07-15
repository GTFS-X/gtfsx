import { Fragment } from 'react';

interface SegmentedProps {
  /** Index of the active option. */
  value: number;
  onChange: (index: number) => void;
  options: string[];
  /** Insert a thin divider before this option index (e.g. before "⇄ Both"). */
  dividerBefore?: number;
  title?: string;
  'aria-label'?: string;
}

/** Segmented toggle — the two/three-way control language (direction picker,
 *  Northbound | Southbound │ ⇄ Both). `dividerBefore` draws a hairline before an
 *  option to set it apart from the primary choices. */
export function Segmented({ value, onChange, options, dividerBefore, title, ...aria }: SegmentedProps) {
  return (
    <div
      className="inline-flex items-center h-[30px] p-0.5 bg-cream border border-sand rounded-md shrink-0"
      role="tablist"
      title={title}
      aria-label={aria['aria-label']}
    >
      {options.map((label, i) => (
        <Fragment key={label}>
          {i === dividerBefore && <span className="w-px self-stretch bg-sand mx-[3px] my-[3px]" aria-hidden="true" />}
          <button
            type="button"
            role="tab"
            aria-selected={i === value}
            onClick={() => onChange(i)}
            className={`px-2.5 h-full rounded-md font-heading font-bold text-[12.5px] whitespace-nowrap shrink-0 transition-colors ${
              i === value ? 'bg-white text-[#d4603a] shadow-sm' : 'text-warm-gray hover:text-brown'
            }`}
          >
            {label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
