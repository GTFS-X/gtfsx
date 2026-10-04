/**
 * Labelled optional-id <select> for the Fares v2 editors. Blank means "any".
 * When the current value is not among the options (a dangling reference, e.g.
 * an imported leg rule naming a network that isn't in networks.txt), it is
 * shown as "<id> (missing)" instead of the select silently displaying "Any"
 * (C3-10).
 */
export function IdSelect({
  label,
  value,
  options,
  anyLabel = 'Any',
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { id: string; label?: string }[];
  anyLabel?: string;
  onChange: (id: string | undefined) => void;
}) {
  const missing = !!value && !options.some((o) => o.id === value);
  return (
    <div>
      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        {label}
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
      >
        <option value="">{anyLabel}</option>
        {missing && <option value={value}>{value} (missing)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label || o.id}</option>
        ))}
      </select>
    </div>
  );
}
