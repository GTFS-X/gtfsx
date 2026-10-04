// Account pre-hijacking: someone signs up with an address they do not own and
// leaves the account pending_verification. When the real owner later
// activates it by proving inbox control, the pre-registered password and
// profile fields must not survive unless the activation also proves it is the
// same person who chose them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locationPath, makeClient } from './_client';
import {
  applyMigrations,
  dbGet,
  extractLink,
  resetDb,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

function pathOf(link: string): string {
  const u = new URL(link);
  return u.pathname + u.search;
}

describe('pending-account activation drops unproven signup state', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  async function squat(email: string, password: string): Promise<void> {
    const res = await makeClient().post('/auth/signup', {
      email,
      password,
      displayName: 'Squatter',
      next: '/orgs/accept?token=whatever',
    });
    expect(res.status).toBe(200);
    const row = await dbGet<{ status: string }>(`SELECT status FROM user WHERE email = ?`, email);
    expect(row?.status).toBe('pending_verification');
  }

  it('magic-link activation removes the pre-registered password and resets the display name', async () => {
    const email = 'victim-ml@agency.example';
    await squat(email, 'squatter-password-1');

    const victim = makeClient();
    const before = capture.emails.length;
    expect((await victim.post('/auth/magic-link/request', { email })).status).toBe(204);
    const mail = capture.emails.slice(before).find((e) => e.to === email)!;
    const link = extractLink(mail.text) ?? extractLink(mail.html);
    expect(link).toContain('/auth/magic-link/consume');
    const consume = await victim.get(pathOf(link!), { noCookie: true });
    expect(consume.status).toBe(302);

    const row = await dbGet<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM user WHERE email = ?`,
      email,
    );
    expect(row?.status).toBe('active');
    expect(row?.display_name).not.toBe('Squatter');

    const cred = await dbGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM credential c JOIN user u ON u.id = c.user_id WHERE u.email = ? AND c.kind = 'password'`,
      email,
    );
    expect(cred?.n).toBe(0);
    const login = await makeClient().post('/auth/login', { email, password: 'squatter-password-1' });
    expect(login.status).toBe(401);
  });

  it('a verify link clicked outside the signup browser activates but drops the password, name and redirect', async () => {
    const email = 'victim-vf@agency.example';
    await squat(email, 'squatter-password-2');
    const mail = capture.emails.find((e) => e.to === email)!;
    const link = extractLink(mail.text) ?? extractLink(mail.html);
    expect(link).toContain('/auth/verify?token=');

    // The victim clicks the unsolicited mail in their own browser.
    const victim = makeClient();
    const verify = await victim.get(pathOf(link!), { noCookie: true });
    expect(verify.status).toBe(302);
    // The squatter-chosen post-verify redirect is ignored.
    expect(locationPath(verify)).not.toBe('/orgs/accept');

    const row = await dbGet<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM user WHERE email = ?`,
      email,
    );
    expect(row?.status).toBe('active');
    expect(row?.display_name).not.toBe('Squatter');
    const login = await makeClient().post('/auth/login', { email, password: 'squatter-password-2' });
    expect(login.status).toBe(401);
  });

  it('a verify link clicked in the signup browser keeps the chosen password and redirect', async () => {
    const email = 'owner@agency.example';
    const owner = makeClient();
    const su = await owner.post('/auth/signup', {
      email,
      password: 'owner-password-1',
      displayName: 'Owner',
      next: '/editor?from=signup',
    });
    expect(su.status).toBe(200);
    expect(owner.cookie).toMatch(/^gb_signup=/);
    const link = capture.linkFor(email)!;
    const verify = await owner.get(pathOf(link));
    expect(verify.status).toBe(302);
    expect(locationPath(verify)).toBe('/editor');

    const row = await dbGet<{ display_name: string }>(`SELECT display_name FROM user WHERE email = ?`, email);
    expect(row?.display_name).toBe('Owner');
    const login = await makeClient().post('/auth/login', { email, password: 'owner-password-1' });
    expect(login.status).toBe(200);
  });

  it('verify-resend sets the binding cookie whether or not the address has an account', async () => {
    const known = 'pending-resend@agency.example';
    await squat(known, 'squatter-password-3');
    const a = await makeClient().post('/auth/verify-resend', { email: known });
    const b = await makeClient().post('/auth/verify-resend', { email: 'nobody@agency.example' });
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(a.headers.get('Set-Cookie') ?? '').toMatch(/gb_signup=/);
    expect(b.headers.get('Set-Cookie') ?? '').toMatch(/gb_signup=/);
  });
});
