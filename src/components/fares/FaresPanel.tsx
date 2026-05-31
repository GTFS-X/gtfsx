import { useState } from 'react';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';
import { FaresEditor } from './FaresEditor';
import { FareZoneTool } from './FareZoneTool';
import { TransfersEditor } from '../transfers/TransfersEditor';

/**
 * Combined Fares + Transfers panel. transfers.txt is conceptually adjacent to
 * fare data (both describe inter-route relationships) and rare enough in
 * authoring that giving it its own sidebar entry was disproportionate. Tabs
 * keep both reachable in one place without crowding the rail.
 */
type FaresTab = 'fares' | 'zones' | 'transfers';

export function FaresPanel() {
  const transferCount = useStore((s) => s.transfers.length);
  // Transfers is gated by the per-feed feature setting (Settings panel). Hidden
  // tab → fall back to Fares so we never render a dead tab.
  const showTransfers = useStore((s) => featureEnabled(s, 'transfers'));
  const [tab, setTab] = useState<FaresTab>('fares');
  const effectiveTab: FaresTab = tab === 'transfers' && !showTransfers ? 'fares' : tab;

  return (
    <div>
      <div className="flex gap-1 -mt-1 mb-4 border-b border-sand">
        <TabButton active={effectiveTab === 'fares'} onClick={() => setTab('fares')}>
          Fares
        </TabButton>
        <TabButton active={effectiveTab === 'zones'} onClick={() => setTab('zones')}>
          Zones
        </TabButton>
        {showTransfers && (
          <TabButton active={effectiveTab === 'transfers'} onClick={() => setTab('transfers')}>
            Transfers
            {transferCount > 0 && (
              <span
                className={`ml-1.5 inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded text-[10px] font-bold tabular-nums ${
                  effectiveTab === 'transfers' ? 'bg-coral text-white' : 'bg-sand text-warm-gray'
                }`}
              >
                {transferCount.toLocaleString()}
              </span>
            )}
          </TabButton>
        )}
      </div>
      {effectiveTab === 'fares' ? <FaresEditor /> : effectiveTab === 'zones' ? <FareZoneTool /> : <TransfersEditor />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 font-heading font-bold text-[13px] border-b-2 transition-colors flex items-center ${
        active
          ? 'text-coral border-coral'
          : 'text-warm-gray border-transparent hover:text-dark-brown'
      }`}
    >
      {children}
    </button>
  );
}
