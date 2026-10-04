// @vitest-environment jsdom
// C4-02: an admin of an org that already has Planner (with a free personal
// plan, which is all /api/me reports) must be routed to the org's billing page,
// never offered a second Checkout:
//   - the Planner card shows "Manage billing" → /orgs/<slug>/billing;
//   - /pricing?plan=agency does not auto-open Checkout;
//   - if Checkout still answers 409 already_subscribed (a stale org list), the
//     user lands on /orgs/<slug>/billing.
// orgToManageBilling / pickCheckoutOrg and the server 409 are pinned
// elsewhere; these render PricingPage with only fetch faked.
import '../../../test-utils/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route as RouterRoute, Routes } from 'react-router-dom';
import { resetStore } from '../../../test-utils/store';
import { json, mockFetch, type FetchCall } from '../../../test-utils/fetch';
import type { OrgSummary } from '../../../services/orgsApi';
import { PricingPage } from '../PricingPage';

const acme = (plan: OrgSummary['plan']): OrgSummary =>
  ({ id: 'o1', slug: 'acme', name: 'Acme Transit', role: 'owner', plan, memberCount: 1, projectCount: 1 }) as OrgSummary;

function seed(orgPlan: OrgSummary['plan'], trialUsed = false) {
  resetStore({
    authChecked: true,
    currentUser: { id: 'u1', email: 'u@example.com', plan: 'free', trialUsed } as never,
    hydrateAuth: async () => {},
    userOrgs: [acme(orgPlan)],
    orgsLoaded: true,
  });
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <RouterRoute path="/pricing" element={<PricingPage />} />
        <RouterRoute path="/orgs/:slug/billing" element={<div>org billing page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const checkoutCalls = (calls: FetchCall[]) => calls.filter((c) => c.path === '/api/billing/checkout');

afterEach(() => { vi.unstubAllGlobals(); });

describe('PricingPage for an admin of a subscribed org (C4-02)', () => {
  let calls: FetchCall[];
  beforeEach(() => {
    calls = mockFetch((c) => {
      if (c.path === '/api/billing/checkout') return json({ url: 'https://checkout.example/session' });
      return undefined;
    });
  });

  it('offers Manage billing for the org instead of a Checkout button', async () => {
    seed('agency');
    const user = userEvent.setup();
    renderAt('/pricing');
    const manage = await screen.findByRole('link', { name: 'Manage billing' });
    expect(manage).toHaveAttribute('href', '/orgs/acme/billing');
    expect(screen.queryByRole('button', { name: /Upgrade to Planner|subscribe now with a card/ })).not.toBeInTheDocument();
    await user.click(manage);
    expect(await screen.findByText('org billing page')).toBeInTheDocument();
    expect(checkoutCalls(calls)).toEqual([]);
  });

  it('an Enterprise org: the Planner button goes to the org billing page, not Checkout', async () => {
    seed('enterprise', true);
    const user = userEvent.setup();
    renderAt('/pricing');
    await user.click(await screen.findByRole('button', { name: /Upgrade to Planner/ }));
    expect(await screen.findByText('org billing page')).toBeInTheDocument();
    expect(checkoutCalls(calls)).toEqual([]);
  });

  // 'agency' is also caught by "already on the requested plan"; 'enterprise'
  // is suppressed only by the managed-org check.
  it.each(['agency', 'enterprise'] as const)(
    'a /pricing?plan=agency deep link does nothing automatically (org on %s)',
    async (orgPlan) => {
      seed(orgPlan, true);
      renderAt('/pricing?plan=agency&interval=year');
      await screen.findAllByText(/Planner/);
      // Give the auto-checkout effect every chance to fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(checkoutCalls(calls)).toEqual([]);
      expect(screen.queryByText('org billing page')).not.toBeInTheDocument();
    },
  );
});

describe('PricingPage when Checkout answers 409 already_subscribed (C4-02)', () => {
  it('sends the user to the org billing page', async () => {
    // The client still thinks the org is free (stale list); the server knows better.
    seed('free', true);
    const calls = mockFetch((c) => {
      if (c.path === '/api/billing/checkout') {
        return json({ error: 'conflict', message: 'Already subscribed', reason: 'already_subscribed' }, 409);
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/pricing');
    await user.click(await screen.findByRole('button', { name: /Upgrade to Planner/ }));
    await waitFor(() => expect(checkoutCalls(calls)).toHaveLength(1));
    expect(await screen.findByText('org billing page')).toBeInTheDocument();
  });
});
