/**
 * C3-03: every explicit sign-out must go through signOutLocally(), which also
 * drops the loaded feed and wipes this browser's IndexedDB copy. A bare
 * clearAuth() leaves the previous user's feed in the editor. There is no DOM
 * test environment, so this checks the call sites in the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src', 'components');
const SIGN_OUT_SITES = [
  'layout/UserMenu.tsx',
  'auth/AccountSettingsPage.tsx',
  'orgs/AcceptInvitationPage.tsx',
];

describe('sign-out call sites (C3-03)', () => {
  for (const rel of SIGN_OUT_SITES) {
    it(`${rel} signs out through signOutLocally, not clearAuth`, () => {
      const text = readFileSync(join(src, rel), 'utf8');
      expect(text).toMatch(/await signOutLocally\(\)/);
      // No direct call and no store selector for it (comments may mention it).
      expect(text).not.toMatch(/clearAuth\(\);|s\.clearAuth\b/);
    });
  }

  it('AccountSettingsPage awaits both sign-out callbacks (sessions and account delete)', () => {
    const text = readFileSync(join(src, 'auth/AccountSettingsPage.tsx'), 'utf8');
    expect(text.match(/await signOutLocally\(\)/g)).toHaveLength(2);
    expect(text).toMatch(/await onSignedOut\(\)/);
    expect(text).toMatch(/await onDeleted\(\)/);
  });
});
