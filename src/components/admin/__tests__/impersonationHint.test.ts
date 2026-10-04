// E2E A5: a stale or forged gb_staff_id localStorage hint showed the red
// impersonation banner, and "Exit impersonation" (refused by the server with
// 422) left it in place. The banner now follows GET /api/me `impersonating`,
// and Exit clears the hint whatever the server answers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { impersonationBannerVisible, impersonationHintIsStale } from '../impersonationHint';

describe('impersonation banner visibility', () => {
  const user = { id: 'u1' };

  it('follows the server flag when /api/me provided it', () => {
    expect(impersonationBannerVisible({ ...user, impersonating: false }, 'staff-1')).toBe(false);
    expect(impersonationBannerVisible({ ...user, impersonating: true }, null)).toBe(true);
  });

  it('falls back to the hint only when the server flag is absent', () => {
    expect(impersonationBannerVisible(user, 'staff-1')).toBe(true);
    expect(impersonationBannerVisible(user, 'u1')).toBe(false);
    expect(impersonationBannerVisible(user, null)).toBe(false);
    expect(impersonationBannerVisible(null, 'staff-1')).toBe(false);
  });

  it('flags the hint as stale once the server says this is not an impersonation', () => {
    expect(impersonationHintIsStale({ impersonating: false }, 'staff-1')).toBe(true);
    expect(impersonationHintIsStale({ impersonating: true }, 'staff-1')).toBe(false);
    expect(impersonationHintIsStale({}, 'staff-1')).toBe(false);
    expect(impersonationHintIsStale({ impersonating: false }, null)).toBe(false);
  });
});

describe('Exit impersonation', () => {
  const src = readFileSync(fileURLToPath(new URL('../ImpersonationBanner.tsx', import.meta.url)), 'utf8');

  it('clears the hint outside the try, so a refused exit clears it too', () => {
    const exit = src.slice(src.indexOf('const exit = async'), src.indexOf('return (\n    <div'));
    const tryEnd = exit.indexOf('\n    }\n', exit.indexOf('} catch (err)'));
    expect(tryEnd).toBeGreaterThan(-1);
    expect(exit.slice(tryEnd)).toMatch(/clearStaffHint\(\);/);
    expect(exit.slice(tryEnd)).toMatch(/await hydrateAuth\(\)/);
  });

  it('uses the server-driven visibility helper', () => {
    expect(src).toMatch(/impersonationBannerVisible\(currentUser, staffId\)/);
  });
});
