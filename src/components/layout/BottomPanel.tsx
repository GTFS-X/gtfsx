
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { TimetableGrid } from '../timetable/TimetableGrid';
import { ValidationPanel } from '../validation/ValidationPanel';

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;
const DEFAULT_HEIGHT = 260;

export function BottomPanel() {
  const { bottomPanelOpen, bottomPanelTab, setBottomPanelTab, toggleBottomPanel } = useStore();
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartY.current - e.clientY;
      setPanelHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragStartHeight.current + delta)));
    };
    const onMouseUp = () => { isDragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleDragStart = (e: React.MouseEvent) => {
    if (!bottomPanelOpen) return;
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;
    e.preventDefault();
  };

  return (
    <div
      className="bg-white border-t border-sand flex flex-col shrink-0"
      style={{ height: bottomPanelOpen ? panelHeight : 40 }}
    >
      {/* Drag handle — only rendered when open */}
      {bottomPanelOpen && (
        <div
          className="h-1.5 shrink-0 flex items-center justify-center cursor-row-resize group hover:bg-sand"
          onMouseDown={handleDragStart}
        >
          <div className="w-8 h-0.5 rounded-full bg-sand group-hover:bg-warm-gray transition-colors" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center px-4 h-10 gap-4 shrink-0 border-b border-sand cursor-pointer select-none"
        onClick={() => toggleBottomPanel()}
      >
        <span className="text-xs text-warm-gray">{bottomPanelOpen ? '▼' : '▲'}</span>
        {(['timetable', 'validation'] as const).map((tab) => (
          <button
            key={tab}
            onClick={(e) => {
              e.stopPropagation();
              setBottomPanelTab(tab);
              if (!bottomPanelOpen) toggleBottomPanel();
            }}
            className={`text-[13px] font-heading font-semibold px-3 py-1 rounded-md transition-colors
              ${bottomPanelTab === tab && bottomPanelOpen
                ? 'bg-coral-light text-coral'
                : 'text-warm-gray hover:text-dark-brown'
              }`}
          >
            {tab === 'timetable' ? 'Timetable' : 'Validation'}
          </button>
        ))}
      </div>

      {/* Content */}
      {bottomPanelOpen && (
        <div className="flex-1 overflow-auto">
          {bottomPanelTab === 'timetable' && <TimetableGrid />}
          {bottomPanelTab === 'validation' && <ValidationPanel />}
        </div>
      )}
    </div>
  );
}
