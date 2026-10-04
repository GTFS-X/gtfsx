// @vitest-environment jsdom
// C3-18: leaving /demo must abort the in-flight demo load (EditorRoute's
// effect cleanup calls controller.abort()), so a demo that finishes loading
// later cannot land in the editor the user moved to. loadDemoFeed's own abort
// checks are pinned in layoutFixes; this pins App's wiring of the signal.
import '../test-utils/dom';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore } from '../test-utils/store';

const demo = vi.hoisted(() => ({ signals: [] as AbortSignal[] }));
vi.mock('../components/layout/demoFeed', () => ({
  loadDemoFeed: (signal: AbortSignal) => { demo.signals.push(signal); return new Promise(() => {}); },
}));
vi.mock('../components/layout/AppShell', () => ({ AppShell: () => <div data-testid="shell" /> }));
vi.mock('../components/admin/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
vi.mock('../components/distribution/RtBreakageDialog', () => ({ RtBreakageDialog: () => null }));
vi.mock('../dev/devAuth', () => ({ startDevAuthBadge: () => () => {} }));
vi.mock('../services/trackBeacon', () => ({
  captureGclidFromUrl: () => {}, captureRefFromUrl: () => {}, trackFeedImportFailed: () => {},
  trackFeedOpened: () => {}, trackGateBlocked: () => {}, trackPageview: () => {},
}));
vi.mock('../db/persistence', () => ({ setupAutoSave: () => () => {}, LAST_PROJECT_KEY: 'k' }));

import App from '../App';

describe('App /demo teardown (C3-18)', () => {
  beforeEach(() => {
    demo.signals.length = 0;
    resetStore({ authChecked: true, currentUser: null, hydrateAuth: async () => {} });
  });

  it('navigating away from /demo aborts the demo load', async () => {
    window.history.replaceState(null, '', '/demo');
    render(<App />);
    await waitFor(() => expect(demo.signals).toHaveLength(1));
    expect(demo.signals[0].aborted).toBe(false);

    act(() => {
      window.history.pushState({ usr: null, key: 'e', idx: 1 }, '', '/editor');
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    expect(demo.signals[0].aborted).toBe(true);
  });
});
