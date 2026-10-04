import type { KeyboardEvent } from 'react';
import type { Stop } from '../../types/gtfs';
import { isActivationKey } from './stopFormHelpers';

/**
 * One row of the Stops list. The row is a `div role="button"` rather than a
 * `<button>` because it contains the visibility-toggle button, and a button
 * nested in a button is invalid HTML (React warns via validateDOMNesting, and
 * browsers may split the markup).
 */
export function StopListRow({
  stop,
  isHidden,
  onOpen,
  onToggleVisibility,
}: {
  stop: Stop;
  isHidden: boolean;
  onOpen: () => void;
  onToggleVisibility: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ignore keys bubbling up from the inner toggle button.
    if (e.target !== e.currentTarget || !isActivationKey(e.key)) return;
    e.preventDefault();
    onOpen();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg transition-colors text-left hover:bg-cream group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-coral"
    >
      {/* Dot — click to toggle stop visibility on the map */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility();
        }}
        className={`w-2.5 h-2.5 rounded-full border-2 shrink-0 transition-all ${
          isHidden
            ? 'opacity-40 hover:opacity-70'
            : 'opacity-100 hover:scale-110'
        }`}
        style={{
          borderColor: '#E8734A',
          backgroundColor: isHidden ? 'transparent' : 'white',
        }}
        title={isHidden ? 'Show on map' : 'Hide from map'}
      />
      <div className={`flex flex-col min-w-0 flex-1 transition-opacity ${isHidden ? 'opacity-40' : ''}`}>
        <span className="text-xs font-medium text-dark-brown truncate">
          {stop.stop_name || 'Unnamed Stop'}
        </span>
        {stop.stop_code && (
          <span className="text-[10px] text-warm-gray">Code: {stop.stop_code}</span>
        )}
      </div>
      <span className="text-[10px] text-warm-gray opacity-0 group-hover:opacity-100 transition-opacity">
        Edit →
      </span>
    </div>
  );
}
