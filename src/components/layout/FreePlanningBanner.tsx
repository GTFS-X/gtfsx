import { useState } from 'react';
import { Banner } from '../ui/Banner';

// Announcement for the Sep 2026 free-planning change (every planning feature
// moved to the free plan; org/team management stays paid). Shown in the editor
// to signed-in and anonymous users alike; the public homepage carries the
// longer version of the same message (public/home/index.html, #free-planning).
// Dismissal is a per-browser convenience only, so storage failures (private
// mode, blocked site data) just mean the banner shows again.
const DISMISS_KEY = 'gtfsx_free_planning_banner_v1';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function FreePlanningBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* per-viewer convenience only */
    }
  };

  return (
    <Banner
      variant="info"
      onDismiss={handleDismiss}
      dismissLabel="Dismiss announcement"
      actions={
        <a
          href="/docs/pricing/"
          className="text-sm font-semibold text-teal underline hover:no-underline whitespace-nowrap"
        >
          Learn more
        </a>
      }
    >
      <strong>All planning features are now free.</strong> Cost, coverage, Title VI, access
      isochrones, and scenario comparison are free to use for the foreseeable future, though we
      can&rsquo;t guarantee they&rsquo;ll stay free forever. Team and organization management
      remains a paid feature.
    </Banner>
  );
}
