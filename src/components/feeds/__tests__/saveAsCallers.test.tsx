// @vitest-environment jsdom
// C4-03: every "save the editor as a new feed" surface must go through
// saveCurrentFeedAsNew, which serializes the baseline + the `__variants`
// envelope (not the live experiment as the baseline) and only marks the store
// saved if nothing changed during the PUT. The helper is pinned in
// saveNewFeed.test.ts; these tests render each caller (SaveAsDialog, My Feeds
// import, Org settings import) and fake only the network (fetch).
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route as RouterRoute, Routes } from 'react-router-dom';
import { resetStore, store } from '../../../test-utils/store';
import { json, mockFetch, type FetchCall } from '../../../test-utils/fetch';
import { createVariantFromCurrent } from '../../../services/variants';
import type { Route } from '../../../types/gtfs';

// The import wizard itself is out of scope: stand in a stub that "finishes"
// an import by calling the page's onComplete, exactly like ImportDialog does.
vi.mock('../../import-export/ImportDialog', () => ({
  ImportDialog: ({ onComplete, completeLabel }: { onComplete: () => Promise<void>; completeLabel?: string }) => (
    <button type="button" onClick={() => { void onComplete(); }}>{`stub: ${completeLabel}`}</button>
  ),
}));

import { SaveAsDialog } from '../SaveAsDialog';
import { MyFeedsPage } from '../MyFeedsPage';
import { OrgSettingsPage } from '../../orgs/OrgSettingsPage';

const route = (id: string) =>
  ({ route_id: id, route_short_name: id, route_long_name: id, route_type: 3 }) as Route;
const created = { id: 'p-new', slug: 'new-feed', name: 'New Feed', ownerType: 'user', ownerId: 'u1', workingStateVersion: 0 };

/** Deferred PUT so a test can edit the store while the save is in flight. */
function deferredPut() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release: () => release() };
}

function apiHandler(put: { gate: Promise<void> } | null) {
  return async (c: FetchCall) => {
    if (c.method === 'POST' && c.path === '/api/projects') return json(created, 201);
    if (c.method === 'PUT' && c.path.endsWith('/working-state')) {
      if (put) await put.gate;
      return json({ workingStateVersion: 1 });
    }
    if (c.path.startsWith('/api/projects')) return json({ projects: [], quota: { used: 0, limit: 10, warning: null }, deleted: [] });
    if (c.path === '/api/orgs/o1') {
      return json({
        organization: { id: 'o1', slug: 'acme', name: 'Acme', plan: 'agency', createdAt: 0 },
        members: [{ userId: 'u1', email: 'u@example.com', role: 'owner', joinedAt: 0 }],
        projectCount: 0,
      });
    }
    if (c.path.startsWith('/api/orgs/o1/invitations')) return json({ invitations: [] });
    // Billing is not under test; a 404 renders the page's billing error state.
    if (c.path.startsWith('/api/billing/')) return json({ error: { code: 'not_found', message: 'n/a' } }, 404);
    return undefined;
  };
}

/** Live store shows the experiment (ALT); the baseline is BASE. */
function seedVariantExperiment() {
  resetStore({
    authChecked: true,
    currentUser: { id: 'u1', email: 'u@example.com', plan: 'free' } as never,
    hydrateAuth: async () => {},
    userOrgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner', plan: 'agency' }] as never,
    orgsLoaded: true,
    routes: [route('BASE')],
    projectName: 'New Feed',
  });
  createVariantFromCurrent('Alt B');
  store().setRoutes([route('ALT')]);
  expect(store().routes.map((r) => r.route_id)).toEqual(['ALT']);
}

function putBody(calls: FetchCall[]) {
  const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/working-state'));
  expect(put, 'working-state PUT was sent').toBeTruthy();
  return put!.body as { routes: Route[]; __variants?: unknown };
}

function expectBaselinePlusVariants(calls: FetchCall[]) {
  const body = putBody(calls);
  expect(body.routes.map((r) => r.route_id)).toEqual(['BASE']);
  expect(body.__variants).toBeTruthy();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SaveAsDialog (C4-03)', () => {
  beforeEach(seedVariantExperiment);

  const renderDialog = () => render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <RouterRoute path="/" element={<SaveAsDialog onClose={() => {}} />} />
        <RouterRoute path="/feeds/:slug" element={<div>opened feed</div>} />
      </Routes>
    </MemoryRouter>,
  );

  it('saves the baseline plus the variants envelope and marks clean', async () => {
    const calls = mockFetch(apiHandler(null));
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('opened feed');
    expectBaselinePlusVariants(calls);
    expect(store().isDirty).toBe(false);
  });

  it('an edit made during the PUT keeps the feed dirty', async () => {
    const put = deferredPut();
    const calls = mockFetch(apiHandler(put));
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    act(() => store().setRoutes([route('EDITED')]));
    put.release();
    await screen.findByText('opened feed');
    expect(store().isDirty).toBe(true);
  });
});

describe('import-create callers (C4-03)', () => {
  beforeEach(seedVariantExperiment);

  // openImport() resets the editor (it is a NEW feed from the file alone), so
  // the experiment state is re-seeded after the dialog opens, standing in for
  // what the import loaded.
  async function finishImport(label: RegExp) {
    act(() => store().markSaved()); // no unsaved-changes confirm in the way
    await userEvent.click(await screen.findByRole('button', { name: 'Import feed' }));
    act(() => {
      store().setRoutes([route('BASE')]);
      createVariantFromCurrent('Alt B');
      store().setRoutes([route('ALT')]);
    });
    await userEvent.click(screen.getByRole('button', { name: label }));
  }

  it('My Feeds → Import saves the baseline plus variants, and an edit during the PUT stays dirty', async () => {
    const put = deferredPut();
    const calls = mockFetch(apiHandler(put));
    render(
      <MemoryRouter initialEntries={['/feeds']}>
        <Routes>
          <RouterRoute path="/feeds" element={<MyFeedsPage />} />
          <RouterRoute path="/feeds/:slug" element={<div>opened feed</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await finishImport(/^stub: Save to/);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    act(() => store().setRoutes([route('EDITED')]));
    put.release();
    await screen.findByText('opened feed');
    expectBaselinePlusVariants(calls);
    expect(store().isDirty).toBe(true);
  });

  it('Org settings → Import saves the baseline plus variants, and an edit during the PUT stays dirty', async () => {
    const put = deferredPut();
    const calls = mockFetch(apiHandler(put));
    render(
      <MemoryRouter initialEntries={['/orgs/acme']}>
        <Routes>
          <RouterRoute path="/orgs/:slug" element={<OrgSettingsPage />} />
          <RouterRoute path="/feeds/:slug" element={<div>opened feed</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await finishImport(/^stub: Save to Acme/);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    act(() => store().setRoutes([route('EDITED')]));
    put.release();
    await screen.findByText('opened feed');
    expectBaselinePlusVariants(calls);
    expect(store().isDirty).toBe(true);
  });
});
