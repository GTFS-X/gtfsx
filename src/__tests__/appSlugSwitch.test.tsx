// @vitest-environment jsdom
// C3-19: the /feeds/:slug route element (ServerEditorRoute in App.tsx) stays
// mounted across /feeds/A -> /feeds/B. Switching slug must
//   - clear the previous slug's error ("Feed not found") and project id, and
//   - pass loadProjectFromServer an isCurrent() that goes false once the slug
//     changes, so a stale snapshot is never applied under the next feed.
// The store half of the guard (loadProjectFromServer honouring isCurrent) is
// pinned in serverSaveLoadGuards; this pins App's wiring. Everything outside
// the route (AppShell, network, persistence) is mocked at the module boundary.
import '../test-utils/dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore } from '../test-utils/store';
import type { ProjectSummary } from '../services/projectsApi';

type LoadOpts = { isCurrent?: () => boolean } | undefined;
const h = vi.hoisted(() => ({
  loads: [] as { id: string; opts: LoadOpts; resolve: (v: boolean) => void }[],
  lists: [] as { resolve: (v: unknown) => void }[],
}));

vi.mock('../components/layout/AppShell', () => ({ AppShell: () => <div data-testid="shell" /> }));
vi.mock('../components/snapshots/ConflictDialog', () => ({
  ConflictDialog: ({ projectId }: { projectId: string }) => <div data-testid="conflict">{projectId}</div>,
}));
vi.mock('../components/admin/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
vi.mock('../components/distribution/RtBreakageDialog', () => ({ RtBreakageDialog: () => null }));
vi.mock('../dev/devAuth', () => ({ startDevAuthBadge: () => () => {} }));
vi.mock('../services/trackBeacon', () => ({
  captureGclidFromUrl: () => {}, captureRefFromUrl: () => {}, trackFeedImportFailed: () => {},
  trackFeedOpened: () => {}, trackGateBlocked: () => {}, trackPageview: () => {},
}));
vi.mock('../db/persistence', () => ({ setupAutoSave: () => () => {}, LAST_PROJECT_KEY: 'k' }));
vi.mock('../db/serverPersistence', () => ({
  resetEditorState: () => {},
  loadProjectFromServer: (id: string, opts: LoadOpts) =>
    new Promise<boolean>((resolve) => { h.loads.push({ id, opts, resolve }); }),
}));
vi.mock('../services/projectsApi', () => ({
  listProjects: () => new Promise((resolve) => { h.lists.push({ resolve }); }),
}));

import App from '../App';

const proj = (id: string, slug: string): ProjectSummary =>
  ({ id, slug, name: slug.toUpperCase(), locked: false }) as unknown as ProjectSummary;

function go(path: string) {
  act(() => {
    window.history.pushState({ usr: null, key: path, idx: window.history.length }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
}

describe('App /feeds/:slug switch (C3-19)', () => {
  beforeEach(() => {
    h.loads.length = 0;
    h.lists.length = 0;
    resetStore({
      authChecked: true,
      currentUser: { id: 'u1', email: 'u@example.com' } as never,
      hydrateAuth: async () => {},
      feedsProjects: [proj('pa', 'a')],
    });
  });

  it('a "Feed not found" slug does not stick when the user moves to a valid slug', async () => {
    window.history.replaceState(null, '', '/feeds/missing');
    render(<App />);
    // Not in feedsProjects -> listProjects; it finds nothing.
    await waitFor(() => expect(h.lists).toHaveLength(1));
    await act(async () => h.lists[0].resolve({ projects: [proj('pa', 'a')], quota: { warning: null } }));
    expect(await screen.findByText('Feed not found')).toBeInTheDocument();

    go('/feeds/a');
    await waitFor(() => expect(h.loads.map((l) => l.id)).toEqual(['pa']));
    expect(screen.queryByText('Feed not found')).not.toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });

  it('switching slug mid-load clears the old project id and makes the old load stale', async () => {
    window.history.replaceState(null, '', '/feeds/a');
    render(<App />);
    await waitFor(() => expect(h.loads).toHaveLength(1));
    const first = h.loads[0];
    expect(first.id).toBe('pa');
    expect(first.opts?.isCurrent?.()).toBe(true);
    await act(async () => first.resolve(true));
    expect(screen.getByTestId('conflict')).toHaveTextContent('pa');

    // b is not cached, so its lookup waits on listProjects. Until it resolves,
    // nothing from feed A may stay attached to the route.
    go('/feeds/b');
    await waitFor(() => expect(h.lists).toHaveLength(1));
    expect(screen.queryByTestId('conflict')).not.toBeInTheDocument();
    expect(first.opts?.isCurrent?.()).toBe(false);

    await act(async () => h.lists[0].resolve({ projects: [proj('pb', 'b')], quota: { warning: null } }));
    await waitFor(() => expect(h.loads.map((l) => l.id)).toEqual(['pa', 'pb']));
    expect(screen.getByTestId('conflict')).toHaveTextContent('pb');
  });

  it('a load still in flight when the slug changes is told it is stale', async () => {
    seedFeeds([proj('pa', 'a'), proj('pb', 'b')]);
    window.history.replaceState(null, '', '/feeds/a');
    render(<App />);
    await waitFor(() => expect(h.loads).toHaveLength(1));
    const stale = h.loads[0];
    go('/feeds/b');
    await waitFor(() => expect(h.loads).toHaveLength(2));
    expect(stale.opts?.isCurrent).toBeTypeOf('function');
    expect(stale.opts!.isCurrent!()).toBe(false);
    expect(h.loads[1].opts!.isCurrent!()).toBe(true);
  });
});

function seedFeeds(projects: ProjectSummary[]) {
  resetStore({
    authChecked: true,
    currentUser: { id: 'u1', email: 'u@example.com' } as never,
    hydrateAuth: async () => {},
    feedsProjects: projects,
  });
}
