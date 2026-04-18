import { PublishPanel } from '../publication/PublishPanel';
import { DistributionPanel } from './DistributionPanel';

// Composite mount for the Publish bottom-tab: renders Phase 3's PublishPanel
// followed by a Distribution subsection (catalog submissions + GTFS-RT feed
// URLs). PublishPanel carries its own `flex-1 overflow-auto`, but inside this
// non-flex parent it becomes a no-op and both sections flow naturally in the
// outer scroll container.
export function PublishWithDistribution() {
  return (
    <div className="flex-1 overflow-auto">
      <PublishPanel />
      <div className="max-w-4xl mx-auto px-4 pb-5">
        <section className="bg-white border border-sand rounded-xl">
          <div className="px-4 pt-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-1">Distribution</h3>
            <p className="text-xs text-warm-gray">
              Where people find and consume your feed once it's published.
            </p>
          </div>
          <DistributionPanel />
        </section>
      </div>
    </div>
  );
}
