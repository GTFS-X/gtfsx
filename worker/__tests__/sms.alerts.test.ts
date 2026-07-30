// Outbound SMS security alerts (worker/sms/alerts.ts): new-sign-in + 2FA-disabled
// texts posted to Twilio's Messages API through the A2P Messaging Service. The
// Twilio HTTP calls are mocked (mirroring auth.twofa.sms.test.ts's fetch spy).
// Alerts are best-effort, so the load-bearing assertion in the integration
// tests is that a Twilio failure never breaks the login / disable it rides on.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  dbRun,
  dbGet,
  dbAll,
  env,
  type SeededUser,
} from './_setup';
import {
  sendSecurityAlert,
  maybeSendNewSigninAlert,
  sendTwofaDisabledAlert,
  securityAlertsConfigured,
  type AlertUser,
} from '../sms/alerts';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Twilio Messages + Verify + Resend capture ───────────────────────────────

interface AlertCapture {
  messages: { to: string; body: string; service: string }[];
  emails: { to: string; text: string; html: string }[];
  /** Force the NEXT Messages POST to return this Twilio error, then clear. */
  nextMessageError: { status: number; code?: number } | null;
  /** Force the NEXT Messages POST's fetch to reject (network failure). */
  throwNextMessage: boolean;
  restore(): void;
}

function setupAlertCapture(): AlertCapture {
  const cap: AlertCapture = {
    messages: [],
    emails: [],
    nextMessageError: null,
    throwNextMessage: false,
    restore: () => spy.mockRestore(),
  };
  const original = globalThis.fetch;
  const spy: MockInstance = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      const params = new URLSearchParams(bodyStr);

      if (url.includes('api.twilio.com') && url.endsWith('/Messages.json')) {
        if (cap.throwNextMessage) {
          cap.throwNextMessage = false;
          throw new Error('simulated network failure');
        }
        cap.messages.push({
          to: params.get('To') ?? '',
          body: params.get('Body') ?? '',
          service: params.get('MessagingServiceSid') ?? '',
        });
        if (cap.nextMessageError) {
          const e = cap.nextMessageError;
          cap.nextMessageError = null;
          return new Response(JSON.stringify({ code: e.code, message: 'twilio error' }), {
            status: e.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ sid: 'SMtest', status: 'queued' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Twilio Verify (some setups may exercise it) — approve nothing special.
      if (url.includes('verify.twilio.com')) {
        return new Response(JSON.stringify({ sid: 'VEtest', status: 'pending' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://api.resend.com/emails')) {
        try {
          const parsed = JSON.parse(bodyStr) as { to?: string; text?: string; html?: string };
          cap.emails.push({ to: String(parsed.to ?? ''), text: String(parsed.text ?? ''), html: String(parsed.html ?? '') });
        } catch {
          // ignore malformed body
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return original(input as RequestInfo, init);
    },
  );
  return cap;
}

// ─── Env toggles (mutate the binding, like auth.twofa.sms.test.ts) ───────────
// The runner loads the developer's .dev.vars, which carries the real Twilio
// API-key trio but NOT a Messaging Service SID — set every key explicitly so
// results don't depend on local credentials.

type MutableEnv = Record<string, string | undefined>;
function setAlertEnv(): void {
  (env as MutableEnv).TWILIO_ACCOUNT_SID = 'ACtest';
  (env as MutableEnv).TWILIO_API_KEY_SID = 'SKtest';
  (env as MutableEnv).TWILIO_API_KEY_SECRET = 'test-secret';
  (env as MutableEnv).TWILIO_VERIFY_SERVICE_SID = 'VAtest';
  (env as MutableEnv).TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
}
function clearAlertEnv(): void {
  (env as MutableEnv).TWILIO_ACCOUNT_SID = undefined;
  (env as MutableEnv).TWILIO_API_KEY_SID = undefined;
  (env as MutableEnv).TWILIO_API_KEY_SECRET = undefined;
  (env as MutableEnv).TWILIO_VERIFY_SERVICE_SID = undefined;
  (env as MutableEnv).TWILIO_MESSAGING_SERVICE_SID = undefined;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Record an SMS opt-in on a user: verified phone + consent evidence.
async function optInSms(userId: string, phone = '+14065551234'): Promise<void> {
  const now = Date.now();
  await dbRun(
    `UPDATE user SET phone = ?, phone_verified_at = ?, sms_consent_at = ?, sms_consent_ip = '203.0.113.9' WHERE id = ?`,
    phone,
    now,
    now,
    userId,
  );
}

// Read back the AlertUser projection the helpers query.
async function alertUserOf(userId: string): Promise<AlertUser> {
  const row = await dbGet<AlertUser>(
    `SELECT id, phone, phone_verified_at, sms_consent_at FROM user WHERE id = ?`,
    userId,
  );
  if (!row) throw new Error('user not found');
  return row;
}

// Insert a past session row directly (drives the new-device heuristic).
async function seedSession(userId: string, userAgent: string | null, createdAt = Date.now()): Promise<void> {
  await dbRun(
    `INSERT INTO session (id, token_hash, user_id, ip, user_agent, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    ulid(),
    ulid(),
    userId,
    userAgent,
    createdAt,
    createdAt,
    createdAt + 90 * DAY_MS,
  );
}

function code6(text: string): string {
  const m = text.match(/(\d{6})/);
  if (!m) throw new Error(`no 6-digit code in: ${text}`);
  return m[1];
}

// ─── Configuration gating ────────────────────────────────────────────────────

describe('SMS alerts — configuration gating', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => clearAlertEnv());

  it('securityAlertsConfigured requires the Messaging Service SID AND the API-key trio', () => {
    clearAlertEnv();
    expect(securityAlertsConfigured(env)).toBe(false);

    // Trio only, no Messaging Service SID → still not configured.
    (env as MutableEnv).TWILIO_ACCOUNT_SID = 'ACtest';
    (env as MutableEnv).TWILIO_API_KEY_SID = 'SKtest';
    (env as MutableEnv).TWILIO_API_KEY_SECRET = 'test-secret';
    expect(securityAlertsConfigured(env)).toBe(false);

    (env as MutableEnv).TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
    expect(securityAlertsConfigured(env)).toBe(true);
  });

  it('unconfigured (no Messaging Service SID) → no send', async () => {
    const cap = setupAlertCapture();
    try {
      // Trio present, Messaging Service SID absent.
      (env as MutableEnv).TWILIO_ACCOUNT_SID = 'ACtest';
      (env as MutableEnv).TWILIO_API_KEY_SID = 'SKtest';
      (env as MutableEnv).TWILIO_API_KEY_SECRET = 'test-secret';
      const user = await seedUser({ email: 'unconfigured@example.com' });
      await optInSms(user.id);

      await sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin');
      await maybeSendNewSigninAlert(env, user.id, 'DeviceA', null);
      await sendTwofaDisabledAlert(env, user.id, null);

      expect(cap.messages.length).toBe(0);
    } finally {
      cap.restore();
    }
  });
});

// ─── Consent gating + happy path + audit ─────────────────────────────────────

describe('SMS alerts — consent gating and audit', () => {
  let cap: AlertCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setAlertEnv();
    cap = setupAlertCapture();
  });
  afterEach(() => {
    cap.restore();
    clearAlertEnv();
  });

  it('a user without a verified phone + consent gets no send', async () => {
    const user = await seedUser({ email: 'noconsent@example.com' });
    // No optInSms — phone/consent are null.
    await sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin');
    expect(cap.messages.length).toBe(0);
  });

  it('an opted-in user gets the text, sent through the Messaging Service, and an audit row', async () => {
    const user = await seedUser({ email: 'optedin@example.com' });
    await optInSms(user.id, '+14065550000');

    await sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin', { ip: '203.0.113.1' });

    expect(cap.messages.length).toBe(1);
    expect(cap.messages[0].to).toBe('+14065550000');
    expect(cap.messages[0].service).toBe('MGtest');
    expect(cap.messages[0].body).toContain('new sign-in');
    expect(cap.messages[0].body).toContain('Reply STOP to opt out');

    const audit = await dbGet<{ metadata_json: string }>(
      `SELECT metadata_json FROM audit_event WHERE action = 'user.sms_alert_sent' AND actor_user_id = ?`,
      user.id,
    );
    expect(audit?.metadata_json).toBe('{"kind":"new_signin"}');
    // The audit payload must never carry the phone number or the message body.
    expect(audit?.metadata_json).not.toContain('4065550000');
    expect(audit?.metadata_json?.toLowerCase()).not.toContain('security alert');
  });

  it('a Twilio 500 is swallowed (no throw) and writes no audit row', async () => {
    const user = await seedUser({ email: 'twilio500@example.com' });
    await optInSms(user.id);
    cap.nextMessageError = { status: 500 };

    await expect(sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin')).resolves.toBeUndefined();

    expect(cap.messages.length).toBe(1); // attempted
    const audit = await dbGet(`SELECT id FROM audit_event WHERE action = 'user.sms_alert_sent'`);
    expect(audit).toBeNull(); // but not audited — the send failed
  });

  it('a Twilio network error is swallowed (no throw)', async () => {
    const user = await seedUser({ email: 'twiliothrow@example.com' });
    await optInSms(user.id);
    cap.throwNextMessage = true;
    await expect(sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin')).resolves.toBeUndefined();
  });

  it('Twilio 21610 (recipient opted out) is swallowed silently — no throw, no audit', async () => {
    const user = await seedUser({ email: 'stopped@example.com' });
    await optInSms(user.id);
    cap.nextMessageError = { status: 400, code: 21610 };

    await expect(sendSecurityAlert(env, await alertUserOf(user.id), 'new_signin')).resolves.toBeUndefined();
    const audit = await dbGet(`SELECT id FROM audit_event WHERE action = 'user.sms_alert_sent'`);
    expect(audit).toBeNull();
  });
});

// ─── New-device heuristic + rate cap ─────────────────────────────────────────

describe('SMS alerts — new-device heuristic', () => {
  let cap: AlertCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setAlertEnv();
    cap = setupAlertCapture();
  });
  afterEach(() => {
    cap.restore();
    clearAlertEnv();
  });

  it('a session already using this user agent suppresses the alert; a different UA sends', async () => {
    const user = await seedUser({ email: 'device@example.com' });
    await optInSms(user.id);
    await seedSession(user.id, 'DeviceA');

    // Same UA as an existing session → suppressed.
    await maybeSendNewSigninAlert(env, user.id, 'DeviceA', null);
    expect(cap.messages.length).toBe(0);

    // A never-seen UA → sends.
    await maybeSendNewSigninAlert(env, user.id, 'DeviceB', null);
    expect(cap.messages.length).toBe(1);
    expect(cap.messages[0].body).toContain('new sign-in');
  });

  it('a session older than the 90-day window does not suppress', async () => {
    const user = await seedUser({ email: 'stale-device@example.com' });
    await optInSms(user.id);
    await seedSession(user.id, 'DeviceA', Date.now() - 91 * DAY_MS);

    await maybeSendNewSigninAlert(env, user.id, 'DeviceA', null);
    expect(cap.messages.length).toBe(1);
  });

  it('caps at 2 new-device alerts per user per day', async () => {
    const user = await seedUser({ email: 'ratecap@example.com' });
    await optInSms(user.id);

    // Three distinct (never-seen) user agents → each is a "new device", but the
    // per-user daily cap allows only two sends.
    await maybeSendNewSigninAlert(env, user.id, 'UA-1', null);
    await maybeSendNewSigninAlert(env, user.id, 'UA-2', null);
    await maybeSendNewSigninAlert(env, user.id, 'UA-3', null);

    expect(cap.messages.length).toBe(2);
  });

  it('does not send for a user who has not opted in', async () => {
    const user = await seedUser({ email: 'device-noconsent@example.com' });
    await maybeSendNewSigninAlert(env, user.id, 'DeviceA', null);
    expect(cap.messages.length).toBe(0);
  });
});

// ─── Integration: login stays unbroken; disable fires the alert ──────────────

describe('SMS alerts — login/disable integration', () => {
  let cap: AlertCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setAlertEnv();
    cap = setupAlertCapture();
  });
  afterEach(() => {
    cap.restore();
    clearAlertEnv();
  });

  async function login(email: string): Promise<{ client: TestClient; user: SeededUser; res: Response }> {
    const user = await seedUser({ email });
    await optInSms(user.id);
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    return { client, user, res };
  }

  it('a first sign-in for an opted-in user texts a new-sign-in alert and still returns a session', async () => {
    const { client, res } = await login('login-alert@example.com');
    expect(res.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
    expect(cap.messages.length).toBe(1);
    expect(cap.messages[0].body).toContain('new sign-in');
  });

  it('login still succeeds when the alert send returns a Twilio error', async () => {
    const user = await seedUser({ email: 'login-500@example.com' });
    await optInSms(user.id);
    cap.nextMessageError = { status: 500 };
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
  });

  it('login still succeeds when the alert send throws (network failure)', async () => {
    const user = await seedUser({ email: 'login-throw@example.com' });
    await optInSms(user.id);
    cap.throwNextMessage = true;
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
  });

  it('login still succeeds when the recipient has opted out (21610)', async () => {
    const user = await seedUser({ email: 'login-21610@example.com' });
    await optInSms(user.id);
    cap.nextMessageError = { status: 400, code: 21610 };
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
  });

  it('disabling 2FA texts a 2FA-disabled alert (even after SMS was the method)', async () => {
    // Seed + log in BEFORE opting in, so the login itself sends no alert and the
    // only captured message is the disable alert.
    const user = await seedUser({ email: 'disable-alert@example.com' });
    const client = makeClient();
    const loginRes = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(loginRes.status).toBe(200);
    expect(cap.messages.length).toBe(0);

    // Now put the user on 2FA with a verified phone + consent on file.
    await optInSms(user.id, '+14065557777');
    await dbRun(`UPDATE user SET twofa_method = 'email', twofa_enrolled_at = ? WHERE id = ?`, Date.now(), user.id);

    const disable = await client.post('/api/me/twofa/disable');
    expect(disable.status).toBe(200);
    const { challenge } = (await disable.json()) as { challenge: string };
    const email = cap.emails.filter((e) => e.to === user.email).at(-1);
    expect(email).toBeTruthy();
    const confirm = await client.post('/api/me/twofa/confirm', { challenge, code: code6(email!.text) });
    expect(confirm.status).toBe(200);
    expect((await confirm.json() as { method: string }).method).toBe('none');

    expect(cap.messages.length).toBe(1);
    expect(cap.messages[0].to).toBe('+14065557777');
    expect(cap.messages[0].body).toContain('two-factor authentication was turned off');

    const audit = await dbAll(`SELECT id FROM audit_event WHERE action = 'user.sms_alert_sent' AND actor_user_id = ?`, user.id);
    expect(audit.length).toBe(1);
  });
});
