// E2E A3: a verify link opened in another browser activates the account but
// discards the signup password; the redirect carries ?set_password=1 and the
// landing page must say so. E2E A4: accounts without a password get "Set a
// password" (reset flow) instead of a change form that needs a current one.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SET_PASSWORD_HREF,
  SET_PASSWORD_NOTICE_PARAM,
  passwordSectionMode,
  showSetPasswordNotice,
} from '../passwordNoticeHelpers';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('set-password notice', () => {
  it('uses the flag the worker appends to the post-verify redirect', () => {
    expect(SET_PASSWORD_NOTICE_PARAM).toBe('set_password');
    expect(read('../../../../worker/auth/routes.ts')).toContain(
      `export const SET_PASSWORD_NOTICE_PARAM = '${SET_PASSWORD_NOTICE_PARAM}'`,
    );
  });

  it('shows only when flagged and the account is not known to have a password', () => {
    const flagged = new URLSearchParams('source=welcome&set_password=1');
    expect(showSetPasswordNotice(flagged, false)).toBe(true);
    expect(showSetPasswordNotice(flagged, undefined)).toBe(true);
    expect(showSetPasswordNotice(flagged, true)).toBe(false);
    expect(showSetPasswordNotice(new URLSearchParams('source=welcome'), false)).toBe(false);
  });

  it('is mounted on both post-verify landings and links to the set-password section', () => {
    expect(read('../../billing/PricingPage.tsx')).toMatch(/<SetPasswordNotice\b/);
    expect(read('../../layout/AppShell.tsx')).toMatch(/<SetPasswordNotice\b/);
    expect(SET_PASSWORD_HREF).toBe('/account#password');
  });
});

describe('account settings password section', () => {
  it('offers "set" only when /api/me says there is no password', () => {
    expect(passwordSectionMode(false)).toBe('set');
    expect(passwordSectionMode(true)).toBe('change');
    expect(passwordSectionMode(undefined)).toBe('change');
  });

  it('renders SetPasswordSection (reset flow) for passwordless accounts', () => {
    const src = read('../AccountSettingsPage.tsx');
    expect(src).toMatch(/passwordSectionMode\(currentUser\.hasPassword\) === 'set' \?\s*\(\s*<SetPasswordSection/);
    expect(src).toMatch(/function SetPasswordSection[\s\S]*?requestPasswordReset\(\{ email \}\)/);
    expect(src.match(/<section id="password">/g)?.length).toBe(2);
  });
});
