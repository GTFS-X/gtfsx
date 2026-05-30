import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';

/**
 * levels.txt editor — station floors. A simple flat table: each level has an
 * id, a numeric index (0 = ground, negative = below grade), and an optional
 * name. Stops reference a level via level_id (set in the stop editor) and
 * pathways connect points across levels.
 */
export function LevelsEditor() {
  const levels = useStore((s) => s.levels);
  const addLevel = useStore((s) => s.addLevel);
  const updateLevel = useStore((s) => s.updateLevel);
  const removeLevel = useStore((s) => s.removeLevel);

  return (
    <div>
      {levels.length === 0 ? (
        <div className="mb-3 p-4 rounded-lg bg-cream text-sm text-warm-gray">
          No levels defined. Add station floors (e.g. Street, Concourse, Platform)
          so stops and pathways can reference them.
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {levels.map((l, idx) => (
            <div key={idx} className="border border-sand rounded-lg bg-white px-3 py-2.5">
              <div className="grid grid-cols-[1fr_88px] gap-2">
                <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                  Level ID
                  <input
                    value={l.level_id}
                    onChange={(e) => updateLevel(idx, { level_id: e.target.value })}
                    className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream font-mono"
                  />
                </label>
                <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                  Index
                  <input
                    type="number"
                    step="0.5"
                    value={l.level_index}
                    onChange={(e) => updateLevel(idx, { level_index: Number(e.target.value) })}
                    className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                  />
                </label>
              </div>
              <label className="mt-2 block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                Name (optional)
                <input
                  value={l.level_name || ''}
                  onChange={(e) => updateLevel(idx, { level_name: e.target.value || undefined })}
                  placeholder="e.g. Concourse"
                  className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                />
              </label>
              <button
                onClick={() => removeLevel(idx)}
                className="mt-2 text-[11px] text-red-400 hover:text-red-600 text-left"
              >
                Delete level
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => addLevel({ level_id: generateId('level'), level_index: 0 })}
        className="w-full px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors"
      >
        + Add Level
      </button>
    </div>
  );
}
