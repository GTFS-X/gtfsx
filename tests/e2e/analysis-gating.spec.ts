import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Free planning (Sep 2026): every analysis panel is available on the free plan,
 * including to anonymous editors. Costs and Coverage render their content, and
 * Access Isochrones, Title VI, and Stop Analysis no longer show the shared
 * PaywallOverlay gate card (plan badge + "Sign up to upgrade" CTA).
 */
test('analysis panels are ungated on the free plan', async ({ page }) => {
  await page.goto('/');

  await openSection(page, /costs/i);
  await expect(page.getByRole('heading', { name: /system totals/i })).toBeVisible();

  // Coverage's "System Summary" only renders after a real Census-data fetch;
  // on a stop-less feed it shows its own empty state instead.
  await openSection(page, /coverage/i);
  await expect(page.getByText(/no stops yet/i)).toBeVisible();

  for (const label of [/costs/i, /coverage/i, /access/i, /title vi/i, /stop analysis/i]) {
    await openSection(page, label);
    await expect(page.getByRole('button', { name: /sign up to upgrade|upgrade plan/i })).toHaveCount(0);
  }

  // Access isochrones call the metered Mapbox API, so signed-out editors get a
  // "Sign in (free)" card (not an upgrade prompt). The server enforces it too
  // (GET /api/mapbox/isochrone → 401 when anonymous).
  await openSection(page, /access/i);
  await expect(page.getByTestId('sign-in-required')).toBeVisible();
  await expect(page.getByText(/sign in \(free\) to use this/i)).toBeVisible();
});
