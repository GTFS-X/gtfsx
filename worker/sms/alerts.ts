import type { Env } from '../env';
import { logAudit } from '../util/audit';
import { rateLimit } from '../util/rateLimit';

// Outbound transactional SMS security alerts (A2P 10DLC campaign). Distinct
// from worker/sms/index.ts (Twilio Verify, which owns 2FA one-time codes): this
// posts a free-form message to the Messages API through the approved Messaging
// Service. Two alert kinds, both declared in the 10DLC campaign's sample set:
// a new-device sign-in and 2FA being turned off.
//
// These are strictly best-effort. An alert send must NEVER break the login or
// account action that triggered it, so every path here swallows-and-logs and
// nothing throws. We never log the message body or the phone number — the audit
// record carries the alert `kind` only.

const MESSAGES_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

export type SecurityAlertKind = 'new_signin' | 'twofa_disabled';

// Message bodies. Hyphenated "GTFS-X" (not the "GTFS·X" middot) so it renders
// on every handset, kept to a single 160-char GSM segment, and matching the
// A2P campaign's declared sample messages. STOP/HELP footer is required by the
// carrier for opted-in transactional traffic.
const ALERT_BODIES: Record<SecurityAlertKind, string> = {
  new_signin:
    "GTFS-X security alert: a new sign-in to your account was detected. If this wasn't you, reset your password at gtfsx.com. Reply STOP to opt out, HELP for help.",
  twofa_disabled:
    "GTFS-X security alert: two-factor authentication was turned off on your account. If this wasn't you, reset your password at gtfsx.com. Reply STOP to opt out, HELP for help.",
};

// The 90-day device-history window for the new-sign-in heuristic (matches the
// session absolute-timeout so we look back over every session that could still
// be alive plus recently-expired ones).
const SIGNIN_DEVICE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
// Per-user daily cap on new-sign-in alerts, via the shared KV limiter.
const SIGNIN_ALERT_MAX = 2;
const SIGNIN_ALERT_WINDOW_SEC = 24 * 60 * 60;

/** The user fields an alert send depends on: opt-in gating + destination. */
export interface AlertUser {
  id: string;
  phone: string | null;
  phone_verified_at: number | null;
  sms_consent_at: number | null;
}

/** Alerts require BOTH the Messaging Service SID and the API-key trio. */
export function securityAlertsConfigured(env: Env): boolean {
  return Boolean(
    env.TWILIO_MESSAGING_SERVICE_SID &&
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_API_KEY_SID &&
      env.TWILIO_API_KEY_SECRET,
  );
}

/** The user opted into SMS: a verified phone plus recorded consent. */
function userOptedIn(user: AlertUser): boolean {
  return Boolean(user.phone && user.phone_verified_at && user.sms_consent_at);
}

function authHeader(env: Env): string {
  // Same HTTP basic auth style as worker/sms/index.ts: base64("SID:secret").
  return 'Basic ' + btoa(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`);
}

export interface AlertContext {
  ip?: string | null;
}

/**
 * Best-effort security-alert text. A no-op when alerts aren't configured or the
 * user hasn't opted in. Never throws — a delivery failure is logged and
 * swallowed so it can't break the login / account action that called it.
 * Twilio 21610 (recipient previously replied STOP) is treated as a silent
 * success: the user opted out at the carrier, nothing to deliver and nothing to
 * audit.
 */
export async function sendSecurityAlert(
  env: Env,
  user: AlertUser,
  kind: SecurityAlertKind,
  ctx: AlertContext = {},
): Promise<void> {
  if (!securityAlertsConfigured(env) || !userOptedIn(user)) return;

  try {
    const res = await fetch(`${MESSAGES_BASE}/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(env),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID as string,
        To: user.phone as string,
        Body: ALERT_BODIES[kind],
      }).toString(),
    });

    if (!res.ok) {
      let code: number | undefined;
      try {
        const body = (await res.json()) as { code?: number };
        code = typeof body.code === 'number' ? body.code : undefined;
      } catch {
        // Unparseable error body — fall through to the generic log.
      }
      // 21610 = recipient has opted out (replied STOP). Expected, not a failure.
      if (code === 21610) return;
      console.error(`[sms-alert] send failed kind=${kind} status=${res.status} code=${code ?? 'n/a'}`);
      return;
    }
  } catch (err) {
    console.error(`[sms-alert] send threw kind=${kind}`, err);
    return;
  }

  await logAudit(env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.sms_alert_sent',
    metadata: { kind },
    ip: ctx.ip ?? null,
  });
}

/**
 * Fire a new-sign-in alert when the sign-in looks like it came from a new
 * device: no session in the last 90 days (live or expired) used this user
 * agent. Rate-limited to {@link SIGNIN_ALERT_MAX} per user per day. Meant to run
 * just BEFORE the caller's `createSession` INSERT, so the session being minted
 * doesn't mask the device as already-seen. Never throws.
 */
export async function maybeSendNewSigninAlert(
  env: Env,
  userId: string,
  userAgent: string | null,
  ip?: string | null,
): Promise<void> {
  // Cheap gate first — no DB work when alerts are switched off.
  if (!securityAlertsConfigured(env)) return;

  let user: AlertUser | null;
  try {
    user = await env.DB.prepare(
      `SELECT id, phone, phone_verified_at, sms_consent_at FROM user WHERE id = ?`,
    )
      .bind(userId)
      .first<AlertUser>();
  } catch (err) {
    console.error('[sms-alert] new-signin user lookup failed', err);
    return;
  }
  if (!user || !userOptedIn(user)) return;

  // New-device heuristic. COALESCE folds a null user_agent to '' so two
  // unknown-UA sign-ins still count as the same "device" (and don't re-alert).
  try {
    const seen = await env.DB.prepare(
      `SELECT 1 AS n FROM session
        WHERE user_id = ? AND COALESCE(user_agent, '') = ? AND created_at >= ?
        LIMIT 1`,
    )
      .bind(userId, userAgent ?? '', Date.now() - SIGNIN_DEVICE_WINDOW_MS)
      .first<{ n: number }>();
    if (seen) return;
  } catch (err) {
    console.error('[sms-alert] new-signin device lookup failed', err);
    return;
  }

  // Cap the alert volume per user. The shared limiter throws when the window is
  // full; swallow that so a capped alert can't break the login.
  try {
    await rateLimit(env, {
      key: `smsalert:signin:${userId}`,
      limit: SIGNIN_ALERT_MAX,
      windowSec: SIGNIN_ALERT_WINDOW_SEC,
    });
  } catch {
    return;
  }

  await sendSecurityAlert(env, user, 'new_signin', { ip });
}

/**
 * Fire a 2FA-disabled alert. No dedup and no new-device check — turning off a
 * second factor is always worth telling the owner about. Gated on config + SMS
 * opt-in (a user who just removed SMS *as their 2FA method* usually still has a
 * verified phone + consent on file, so they still get the text). Never throws.
 */
export async function sendTwofaDisabledAlert(env: Env, userId: string, ip?: string | null): Promise<void> {
  if (!securityAlertsConfigured(env)) return;

  let user: AlertUser | null;
  try {
    user = await env.DB.prepare(
      `SELECT id, phone, phone_verified_at, sms_consent_at FROM user WHERE id = ?`,
    )
      .bind(userId)
      .first<AlertUser>();
  } catch (err) {
    console.error('[sms-alert] twofa-disabled user lookup failed', err);
    return;
  }
  if (!user) return;

  await sendSecurityAlert(env, user, 'twofa_disabled', { ip });
}
