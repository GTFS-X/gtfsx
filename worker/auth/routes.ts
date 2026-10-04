import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser } from '../env';
import {
  accountDeleted,
  conflict,
  emailSendFailed,
  emailUnverified,
  forbidden,
  invalidCredentials,
  twofaRequired,
  validationFailed,
} from '../util/errors';
import { generateToken, hashPassword, sha256Hex, verifyPassword } from '../util/crypto';
import { rateLimit, clientIp } from '../util/rateLimit';
import { logAudit } from '../util/audit';
import {
  createSession,
  revokeSession,
  revokeAllSessions,
  sessionCookie,
  clearSessionCookie,
} from './session';
import {
  createAuthToken,
  resolveAuthToken,
  consumeAuthToken,
  invalidateAuthTokensForUser,
} from './tokens';
import { requireAuth } from './middleware';
import { clearImpersonationBinding, clearImpersonatorCookie } from '../admin/impersonation';
import { googleRouter } from './google';
import {
  twofaRequirement,
  startChallenge,
  verifyChallengeCode,
  resendChallenge,
} from './twofa';
import {
  sendAccountDeletedNotice,
  sendVerifyEmail,
  sendMagicLink,
  sendPasswordReset,
  sendWelcomeEmail,
} from '../email';
import { maybeSendNewSigninAlert } from '../sms/alerts';
import { TwilioVerifyError } from '../sms';
import { verifyTurnstile } from '../util/turnstile';
import { insertEvent } from '../events/insert';
import { hashEmailHex } from '../marketing/ads/userIdentifiers';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(10).max(256);
const displayNameSchema = z.string().trim().min(1).max(120);

// `next` is the path to land on after verify-email completes. Used by the
// invitee flow to bounce the user back to /orgs/accept?token=… so they skip
// the tier picker entirely. Validated as a same-origin relative path before
// being honored at redirect time.
//
// `invitationToken` is the raw invitation token from the email link. Its
// presence is the signal that the signing-up user already proved ownership
// of this email address by clicking the invitation (which the server only
// ever sent to that email). When the token resolves and matches the
// submitted email, the user is activated immediately and gets a session —
// no second confirmation email is sent.
const signupSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  turnstileToken: z.string().max(2048).optional(),
  next: z.string().max(512).optional(),
  invitationToken: z.string().max(2048).optional(),
  // Google Ads click identifiers, forwarded by the signup form from the
  // session store (captureGclidFromUrl → sessionStorage). Same shape/caps as
  // the analytics beacon + demo-lead form. Used only to stamp the server-side
  // `sign_up` conversion event on a FRESH signup — never persisted on `user`.
  gclid: z.string().max(256).optional(),
  gbraid: z.string().max(256).optional(),
  wbraid: z.string().max(256).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

const emailOnlySchema = z.object({ email: emailSchema });

const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

// Equalizes timing between "user not found" and "bad password". Generated lazily once.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('timing-equalizer-' + ulid());
  return dummyHashPromise;
}

// Validate a post-verify redirect path. Must be a same-origin relative path —
// reject anything that could resolve to a different host (`//evil`,
// `http://…`, protocol-relative or absolute URLs). Returns undefined to mean
// "no override; use the default redirect."
function safeNext(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//')) return undefined;
  if (raw.length > 512) return undefined;
  // Disallow control chars + newlines to keep this safe inside Location headers.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return raw;
}


// Fixed minimum latency on signup paths to avoid leaking existence via response-time skew.
// The delay must settle even when `work()` throws — otherwise the conflict path returns
// faster than the success path and the email-taken check becomes observable.
async function withMinDelay<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work();
  } finally {
    const remaining = ms - (Date.now() - start);
    if (remaining > 0) {
      await new Promise<void>((res) => setTimeout(res, remaining));
    }
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: AuthedUser['status'];
  staff: number;
  deleted_at: number | null;
  plan?: AuthedUser['plan'] | null;
  plan_status?: AuthedUser['planStatus'] | null;
}

async function findUserByEmail(env: AppContext['Bindings'], email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status FROM user WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>();
}

function shapeUser(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    staff: row.staff === 1,
    plan: row.plan ?? 'free',
    planStatus: row.plan_status ?? 'active',
  };
}

async function parseJson<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

// `event.session_id` is NOT NULL and a signup POST has no client beacon
// session — mint a random id per event (same shape as the client's and the
// demo-lead form's, see worker/marketing/demoLead.ts).
function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Trim + cap a forwarded click identifier → null when empty. zod already caps
// at 256; this collapses empty strings the client may send to NULL.
function clickId(value: string | undefined): string | null {
  const trimmed = value?.trim().slice(0, 256);
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─── Unproven-signup protection (account pre-hijacking) ──────────────────
//
// A pending_verification account was created by whoever submitted the signup
// form; nothing proves they control the address. Anyone can therefore
// pre-register a victim's email with a password of their choosing. When the
// account is later activated by someone who DOES prove control of the inbox,
// the pre-existing password and profile fields must not carry over unless the
// activation also proves it is the same person who chose them.
//
//  - Magic-link consume: proves inbox control only → always drop.
//  - Verify-email link: the verify mail is sent on signup (and resend), so the
//    clicker proves inbox control; it is the same person as the signup only if
//    the click happens in the browser that requested that mail. That browser
//    holds the gb_signup cookie whose hash is stored on the verify token.
//    Unbound clicks still activate + sign in, but drop the password and
//    squatter-chosen fields (the owner can set a password via reset / sign in
//    via magic link).
//  - Google: handled in ./google.ts.

const SIGNUP_BINDING_COOKIE = 'gb_signup';
const SIGNUP_BINDING_MAX_AGE_SEC = 24 * 60 * 60; // verify_email token TTL

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name && v) return v;
  }
  return null;
}

/**
 * Bind a verify mail to the requesting browser: reuse (or mint) the
 * gb_signup nonce, append its cookie to the response, and return the hash to
 * store in the verify token's metadata.
 */
async function signupBinding(c: Context<AppContext>): Promise<string> {
  const existing = readCookie(c.req.raw, SIGNUP_BINDING_COOKIE);
  const nonce = existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing) ? existing : generateToken();
  c.header(
    'Set-Cookie',
    `${SIGNUP_BINDING_COOKIE}=${nonce}; Max-Age=${SIGNUP_BINDING_MAX_AGE_SEC}; Path=/auth; HttpOnly; Secure; SameSite=Lax`,
    { append: true },
  );
  return sha256Hex(nonce);
}

async function isSignupBound(req: Request, metadata: Record<string, unknown> | null): Promise<boolean> {
  const expected = metadata?.signupBinding;
  if (typeof expected !== 'string' || !expected) return false;
  const nonce = readCookie(req, SIGNUP_BINDING_COOKIE);
  if (!nonce) return false;
  return (await sha256Hex(nonce)) === expected;
}

function clearSignupBindingCookie(): string {
  return `${SIGNUP_BINDING_COOKIE}=; Max-Age=0; Path=/auth; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Drop state chosen by whoever pre-registered a still-unproven account: the
 * password credential, the display name (reset to the email's local part),
 * and any outstanding verify-email links. Call BEFORE flipping
 * pending_verification → active on an activation that does not prove the
 * activator chose that state.
 */
async function dropUnprovenSignupState(
  env: AppContext['Bindings'],
  userId: string,
  email: string,
): Promise<{ droppedPassword: boolean }> {
  const now = Date.now();
  const dropped = await env.DB.prepare(`DELETE FROM credential WHERE user_id = ? AND kind = 'password'`)
    .bind(userId)
    .run();
  const local = email.split('@')[0]?.trim().slice(0, 120) || 'Member';
  await env.DB.prepare(`UPDATE user SET display_name = ?, updated_at = ? WHERE id = ?`)
    .bind(local, now, userId)
    .run();
  await invalidateAuthTokensForUser(env, userId, 'verify_email');
  return { droppedPassword: (dropped.meta?.changes ?? 0) > 0 };
}

/**
 * Query flag on the post-verify redirect telling the client the signup
 * password was discarded (unbound verify click), so it can explain why and
 * offer to set one instead of failing silently at the next password login.
 */
export const SET_PASSWORD_NOTICE_PARAM = 'set_password';

export const authRouter = new Hono<AppContext>();

authRouter.get('/ping', (c) => c.json({ ok: true }));

// Google OAuth ("Continue with Google"), issue #20. Mounted at /auth/google.
authRouter.route('/google', googleRouter);

// ─── Signup ────────────────────────────────────────────────────────────────
//
// Three paths based on the existing user row:
//   - none:                fresh signup (insert user + credential + token, email).
//   - active / disabled:   409 — the email is in use by a real account.
//   - deleted_soft:        409 reason=account_deleted — the row still holds the
//                          (UNIQUE) email until the reaper purges it.
//   - pending_verification: treat as a *retry*. Refresh the password credential,
//     invalidate outstanding verify tokens, send a new verify email. This
//     recovers users who hit a previous partial-signup bug (user row written
//     but credential INSERT failed — happened with an earlier PBKDF2-600k /
//     workerd ceiling combination). Safe because only the email owner can
//     consume the verify link; an unexpected email is the signal that
//     someone else tried to sign up with this address.
//
// Fresh-signup writes are followed by `sendVerifyEmail`; if that throws we
// roll back the user row (credential + token FK-cascade away) so the email
// isn't stuck in pending_verification limbo.
authRouter.post('/signup', async (c) => {
  const body = await parseJson(c, signupSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:signup:ip:${ip}`, limit: 10, windowSec: 3600 });
  await rateLimit(c.env, { key: `auth:signup:email:${body.email}`, limit: 6, windowSec: 3600 });
  // Bot gate. Verifies the Turnstile token before any DB write or email
  // send. No-op when the secret isn't configured (dev fallback).
  await verifyTurnstile(c.env, body.turnstileToken, ip);

  // Invitation-token fast path. If the user clicked an invite email link
  // their possession of the token proves they own this address, so we skip
  // the verify-email round-trip and activate immediately. The token must
  // still be live and match the submitted email. We don't consume it here —
  // /api/orgs/invitations/accept will do that when the user joins the org.
  let autoActivate = false;
  if (body.invitationToken) {
    const resolved = await resolveAuthToken(c.env, body.invitationToken, 'invitation');
    if (
      resolved &&
      !resolved.consumedAt &&
      resolved.expiresAt > Date.now() &&
      resolved.email &&
      resolved.email.toLowerCase() === body.email.toLowerCase()
    ) {
      autoActivate = true;
    }
  }

  let autoActivatedUserId: string | null = null;
  // Set true only on a genuinely fresh account creation (new user row) — NOT
  // on the pending_verification retry path and NOT on the 409 conflict paths. Gates the `sign_up` conversion event so
  // it fires once per real signup, never on logins or repeat submissions.
  let freshSignup = false;

  await withMinDelay(200, async () => {
    const existing = await findUserByEmail(c.env, body.email);

    if (existing && (existing.status === 'active' || existing.status === 'disabled')) {
      throw conflict('Account already exists — sign in instead');
    }

    if (existing && existing.status === 'deleted_soft') {
      // user.email is UNIQUE and the soft-deleted row keeps it until the
      // reaper purges the account, so a fresh INSERT would fail. Say why.
      throw conflict(
        'This email belongs to an account scheduled for deletion. Contact hello@gtfsx.com to restore it.',
        { reason: 'account_deleted' },
      );
    }

    if (existing && existing.status === 'pending_verification') {
      // Retry path.
      const now = Date.now();
      const passwordHash = await hashPassword(body.password);

      // Update display name if the caller provided a different one, so users
      // can correct a typo from their first attempt.
      await c.env.DB.prepare(
        `UPDATE user SET display_name = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(body.displayName, now, existing.id)
        .run();

      const existingCred = await c.env.DB.prepare(
        `SELECT id FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
      )
        .bind(existing.id)
        .first<{ id: string }>();

      if (existingCred) {
        await c.env.DB.prepare(
          `UPDATE credential SET password_hash = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(passwordHash, now, existingCred.id)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
           VALUES (?, ?, 'password', ?, ?, ?)`,
        )
          .bind(ulid(), existing.id, passwordHash, now, now)
          .run();
      }

      // Invitation-driven retry: activate the row and let the caller make a
      // session. Outstanding verify_email tokens get invalidated either way.
      await invalidateAuthTokensForUser(c.env, existing.id, 'verify_email');
      if (autoActivate) {
        await c.env.DB.prepare(
          `UPDATE user SET status = 'active', updated_at = ? WHERE id = ?`,
        )
          .bind(now, existing.id)
          .run();
        autoActivatedUserId = existing.id;
        await logAudit(c.env, {
          actorUserId: existing.id,
          subjectType: 'user',
          subjectId: existing.id,
          action: 'user.signup.activated_by_invitation',
          ip,
        });
        return;
      }
      // Tag this as a signup-flow verification so the post-verify redirect
      // can route the user through the welcome / pick-a-plan step.
      const token = await createAuthToken(c.env, {
        kind: 'verify_email',
        userId: existing.id,
        metadata: { flow: 'signup', next: safeNext(body.next), signupBinding: await signupBinding(c) },
      });
      const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
      try {
        await sendVerifyEmail(c.env, body.email, link);
      } catch (err) {
        console.error('[signup:retry] verify email send failed', err);
        throw emailSendFailed();
      }

      await logAudit(c.env, {
        actorUserId: existing.id,
        subjectType: 'user',
        subjectId: existing.id,
        action: 'user.signup.retry',
        ip,
      });
      return;
    }

    // Fresh signup path (no existing user).
    // Invitation-driven fresh signups go straight to active; everything else
    // starts pending_verification and waits for the email click.
    const now = Date.now();
    const userId = ulid();
    const initialStatus = autoActivate ? 'active' : 'pending_verification';
    await c.env.DB.prepare(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(userId, body.email, body.displayName, initialStatus, now, now)
      .run();

    try {
      const passwordHash = await hashPassword(body.password);
      await c.env.DB.prepare(
        `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
         VALUES (?, ?, 'password', ?, ?, ?)`,
      )
        .bind(ulid(), userId, passwordHash, now, now)
        .run();

      if (autoActivate) {
        autoActivatedUserId = userId;
        freshSignup = true;
        await logAudit(c.env, {
          actorUserId: userId,
          subjectType: 'user',
          subjectId: userId,
          action: 'user.signup.activated_by_invitation',
          ip,
        });
        return;
      }

      const token = await createAuthToken(c.env, {
        kind: 'verify_email',
        userId,
        metadata: { flow: 'signup', next: safeNext(body.next), signupBinding: await signupBinding(c) },
      });
      const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
      await sendVerifyEmail(c.env, body.email, link);
    } catch (err) {
      // Roll back the user row so the email isn't blocked from retrying.
      // FK-cascades wipe any credential + auth_token we may have inserted.
      console.error('[signup] fresh signup failed — rolling back user row', err);
      await c.env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();
      await logAudit(c.env, {
        actorUserId: null,
        subjectType: 'user',
        subjectId: userId,
        action: 'user.signup.rolled_back',
        metadata: { error: err instanceof Error ? err.message : String(err) },
        ip,
      });
      if (err instanceof Error && err.message.includes('Resend')) {
        throw emailSendFailed();
      }
      throw err;
    }

    await logAudit(c.env, {
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      action: 'user.signup',
      ip,
    });
    freshSignup = true;
  });

  // Google Ads `sign_up` conversion. Fires once per FRESH signup that carried
  // an ad click id — mirrors the demo_request emission (worker/marketing/
  // demoLead.ts): a cookieless, click-ID-stamped `event` row the OCI cron
  // uploads (worker/marketing/ads/oci.ts). Written here (after the account is
  // durably created + any verify email sent) so a rolled-back signup leaves no
  // conversion behind. Organic signups (no click id) write nothing — there's
  // nothing to attribute. Best-effort: an analytics write must never fail the
  // signup that already succeeded.
  const gclid = clickId(body.gclid);
  const gbraid = clickId(body.gbraid);
  const wbraid = clickId(body.wbraid);
  if (freshSignup && (gclid || gbraid || wbraid)) {
    try {
      await insertEvent(c.env.DB, {
        kind: 'sign_up',
        path: '/signup',
        ref: null,
        sessionId: randomSessionId(),
        country: c.req.header('CF-IPCountry') ?? null,
        label: null,
        gclid,
        gbraid,
        wbraid,
        // Hashed account email, so the upload can carry a user identifier
        // beside the click id. Hashed here — the address itself is never
        // written to `event`. See worker/marketing/ads/userIdentifiers.ts.
        emailSha256: await hashEmailHex(body.email),
      });
    } catch (err) {
      console.error('[signup] sign_up conversion event insert failed', err);
    }
  }

  // Invitation-driven signup: log the user in right now so the SPA can
  // redirect them straight to /orgs/accept without another round-trip
  // through verify-email. The user shape mirrors /api/me.
  if (autoActivatedUserId) {
    const userId = autoActivatedUserId;
    const userRow = await c.env.DB.prepare(
      `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status
         FROM user WHERE id = ?`,
    ).bind(userId).first<UserRow>();
    if (userRow) {
      const session = await createSession(c.env, {
        userId,
        ip,
        userAgent: c.req.header('User-Agent') ?? null,
      });
      c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      await logAudit(c.env, {
        actorUserId: userId,
        subjectType: 'session',
        subjectId: userId,
        action: 'session.login',
        metadata: { method: 'signup_invitation' },
        ip,
      });
      return c.json({ activated: true, user: shapeUser(userRow) });
    }
  }

  return c.json({ activated: false });
});

// ─── Verify email ──────────────────────────────────────────────────────────
// Activates the account, opens a session, and redirects to the editor with a
// welcome flag — mirrors the magic-link consume flow so users land signed in
// without re-entering credentials. The Set-Cookie on a same-origin 302 is the
// same pattern magic-link relies on; both are served by the Worker behind the
// SPA and via the Vite proxy in dev, so the cookie is set against the SPA
// origin and visible on the redirect target.
authRouter.get('/verify', async (c) => {
  const token = c.req.query('token');
  const invalidRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/verify-email?status=invalid`, 302);
  const alreadyVerifiedRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/verify-email?status=already_verified`, 302);
  if (!token) return invalidRedirect();

  const resolved = await resolveAuthToken(c.env, token, 'verify_email');
  if (!resolved || !resolved.userId) {
    return invalidRedirect();
  }
  // Distinguish a re-clicked link (token already consumed for a now-active
  // user) from a genuinely invalid/expired token. The "already verified"
  // case shows friendlier copy + a sign-in CTA instead of a "resend" prompt.
  if (resolved.consumedAt) {
    const alreadyActive = await c.env.DB
      .prepare(`SELECT status FROM user WHERE id = ?`)
      .bind(resolved.userId)
      .first<{ status: string }>();
    if (alreadyActive?.status === 'active') return alreadyVerifiedRedirect();
    return invalidRedirect();
  }
  if (resolved.expiresAt <= Date.now()) return invalidRedirect();

  const userRow = await c.env.DB.prepare(`SELECT id, status, email FROM user WHERE id = ?`)
    .bind(resolved.userId)
    .first<{ id: string; status: string; email: string }>();
  if (!userRow || userRow.status === 'deleted_soft' || userRow.status === 'disabled') {
    return invalidRedirect();
  }
  // The pending_verification row is what we expect; if the user has already
  // been activated (e.g. another verify link from a duplicate signup retry
  // arrived first), short-circuit to the "already verified" page.
  if (userRow.status === 'active') {
    await consumeAuthToken(c.env, resolved.tokenHash);
    return alreadyVerifiedRedirect();
  }

  // Single-use: claim the token before any side effect. A concurrent click
  // that loses the claim lands on the "already verified" page the winner
  // makes true.
  if (!(await consumeAuthToken(c.env, resolved.tokenHash))) {
    return alreadyVerifiedRedirect();
  }

  // Clicked in the browser that requested this verify mail? If not, the
  // clicker owns the inbox but did not choose the password / profile fields
  // on this pending account — drop them, and ignore the stored redirect.
  const bound = await isSignupBound(c.req.raw, resolved.metadata);
  let droppedPassword = false;
  if (!bound) {
    ({ droppedPassword } = await dropUnprovenSignupState(c.env, userRow.id, userRow.email));
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending_verification'`,
  )
    .bind(now, resolved.userId)
    .run();

  const ip = clientIp(c.req.raw);
  const session = await createSession(c.env, {
    userId: resolved.userId,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));
  c.header('Set-Cookie', clearSignupBindingCookie(), { append: true });

  await logAudit(c.env, {
    actorUserId: resolved.userId,
    subjectType: 'user',
    subjectId: resolved.userId,
    action: 'user.verify_email',
    metadata: bound ? undefined : { unboundActivation: true },
    ip,
  });
  await logAudit(c.env, {
    actorUserId: resolved.userId,
    subjectType: 'session',
    subjectId: resolved.userId,
    action: 'session.login',
    metadata: { method: 'verify_email' },
    ip,
  });

  // First activation of a password account → send the one-time welcome email.
  // Best-effort: a Resend hiccup must never block activation or the redirect
  // (mirrors the signup-retry pattern above). The pending→active UPDATE above
  // only runs once per user, so this fires at most once.
  try {
    await sendWelcomeEmail(c.env, userRow.email);
  } catch (err) {
    console.error('[verify] welcome email send failed', err);
  }

  // Signup verifications land on the /pricing page unless the signup carried a
  // `next` (e.g. a /pricing card click carries ?plan= so checkout resumes
  // automatically, or an invitee accepting an org invite goes straight to the
  // accept page). Other verify-email flows fall back to the editor.
  const isSignupFlow = resolved.metadata?.flow === 'signup';
  const next = bound && typeof resolved.metadata?.next === 'string'
    ? safeNext(resolved.metadata.next)
    : undefined;
  const target = next
    ? next
    : isSignupFlow
      ? '/pricing?source=welcome'
      : '/?welcome=1';
  const notice = droppedPassword
    ? `${target.includes('?') ? '&' : '?'}${SET_PASSWORD_NOTICE_PARAM}=1`
    : '';
  return c.redirect(`${c.env.APP_ORIGIN}${target}${notice}`, 302);
});

// ─── Resend verification email ─────────────────────────────────────────────
// Public (no auth) so a user blocked at login by email_unverified can still
// request a fresh link. Always returns 204 — no enumeration.
authRouter.post('/verify-resend', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:verify-resend:ip:${ip}`, limit: 10, windowSec: 3600 });
  await rateLimit(c.env, { key: `auth:verify-resend:email:${body.email}`, limit: 6, windowSec: 3600 });

  // Always bind (and set the cookie) so the response doesn't reveal whether
  // the address has a pending account.
  const binding = await signupBinding(c);
  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status === 'pending_verification') {
    await invalidateAuthTokensForUser(c.env, user.id, 'verify_email');
    // A pending_verification user only exists from a signup that hasn't yet
    // been confirmed, so the resend carries the same signup-flow tag.
    const token = await createAuthToken(c.env, {
      kind: 'verify_email',
      userId: user.id,
      metadata: { flow: 'signup', signupBinding: binding },
    });
    const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
    try {
      await sendVerifyEmail(c.env, user.email, link);
    } catch (err) {
      console.error('[verify-resend] send failed', err);
      throw emailSendFailed();
    }
  }

  return c.body(null, 204);
});

// ─── Login ─────────────────────────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await parseJson(c, loginSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:login:ip:${ip}`, limit: 20, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:login:email:${body.email}`, limit: 10, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  const credential = user
    ? await c.env.DB.prepare(
        `SELECT password_hash FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
      )
        .bind(user.id)
        .first<{ password_hash: string | null }>()
    : null;

  if (!user || !credential?.password_hash) {
    // Equalize timing with a dummy verify.
    await verifyPassword(body.password, await dummyHash());
    throw invalidCredentials();
  }

  const ok = await verifyPassword(body.password, credential.password_hash);
  if (!ok) throw invalidCredentials();

  // Only after the correct password: tell the owner why, same copy as the
  // Google and magic-link paths.
  if (user.status === 'deleted_soft') throw accountDeleted();
  if (user.status === 'disabled') {
    throw forbidden('Account unavailable');
  }

  if (user.status === 'pending_verification') {
    // Block login but echo the email so the frontend can offer "resend verification email".
    throw emailUnverified({ email: user.email });
  }

  // 2FA gate. Placed AFTER the status gates so it never changes the error
  // surface for unverified/disabled accounts. When required, we send a code,
  // set NO session cookie, and return 403 twofa_required with the challenge
  // token — the SPA completes the login via POST /auth/2fa/verify.
  const twofa = await twofaRequirement(c.env, user.id);
  if (twofa.required) {
    const challenge = await startChallenge(c.env, {
      user: { id: user.id, email: user.email },
      purpose: 'login',
      method: twofa.method,
      ip,
    });
    throw twofaRequired({
      method: challenge.method,
      challenge: challenge.token,
      destination: challenge.destination,
      resend_cooldown_sec: challenge.resendCooldownSec,
    });
  }

  // Best-effort new-device security alert (before createSession so the just-
  // minted session doesn't mask the device as already-seen). Never throws.
  await maybeSendNewSigninAlert(c.env, user.id, c.req.header('User-Agent') ?? null, ip);

  const session = await createSession(c.env, {
    userId: user.id,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'session',
    subjectId: user.id,
    action: 'session.login',
    metadata: { method: 'password' },
    ip,
  });

  return c.json({ user: shapeUser(user) });
});

// ─── 2FA: verify a login challenge ───────────────────────────────────────────
const twofaVerifySchema = z.object({
  challenge: z.string().min(1).max(2048),
  code: z.string().trim().min(1).max(12),
});

const twofaResendSchema = z.object({
  challenge: z.string().min(1).max(2048),
});

authRouter.post('/2fa/verify', async (c) => {
  const body = await parseJson(c, twofaVerifySchema);
  const ip = clientIp(c.req.raw);

  const { userId } = await verifyChallengeCode(c.env, {
    token: body.challenge,
    code: body.code,
    allowedPurposes: ['login'],
    ip,
  });

  // The account could have been disabled between challenge issue and verify.
  const userRow = await c.env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status FROM user WHERE id = ?`,
  )
    .bind(userId)
    .first<UserRow>();
  if (!userRow || userRow.status !== 'active') {
    throw forbidden('Account unavailable');
  }

  // Best-effort new-device security alert (before createSession so the just-
  // minted session doesn't mask the device as already-seen). Never throws.
  await maybeSendNewSigninAlert(c.env, userId, c.req.header('User-Agent') ?? null, ip);

  const session = await createSession(c.env, {
    userId,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: userId,
    subjectType: 'session',
    subjectId: userId,
    action: 'session.login',
    metadata: { method: '2fa' },
    ip,
  });

  return c.json({ user: shapeUser(userRow) });
});

// ─── 2FA: resend the login code ──────────────────────────────────────────────
authRouter.post('/2fa/resend', async (c) => {
  const body = await parseJson(c, twofaResendSchema);
  const { resendCooldownSec } = await resendChallenge(c.env, {
    token: body.challenge,
    ip: clientIp(c.req.raw),
  });
  return c.json({ resend_cooldown_sec: resendCooldownSec });
});

// ─── Magic link request ────────────────────────────────────────────────────
authRouter.post('/magic-link/request', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:magic:ip:${ip}`, limit: 6, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:magic:email:${body.email}`, limit: 4, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status === 'deleted_soft') {
    // No sign-in link for an account scheduled for deletion. Tell the inbox
    // owner why instead of sending nothing; the HTTP response is the same 204
    // either way, so this adds no enumeration surface.
    await sendAccountDeletedNotice(c.env, user.email);
  } else if (user) {
    const token = await createAuthToken(c.env, { kind: 'magic_link', userId: user.id });
    const link = `${c.env.APP_ORIGIN}/auth/magic-link/consume?token=${token}`;
    await sendMagicLink(c.env, user.email, link);
    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'session',
      subjectId: user.id,
      action: 'session.magic_link_requested',
      ip,
    });
  }

  return c.body(null, 204);
});

// ─── Magic link consume ────────────────────────────────────────────────────
authRouter.get('/magic-link/consume', async (c) => {
  const token = c.req.query('token');
  const failRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/login?error=magic_link_invalid`, 302);
  if (!token) return failRedirect();

  const resolved = await resolveAuthToken(c.env, token, 'magic_link');
  if (!resolved || resolved.consumedAt || resolved.expiresAt <= Date.now() || !resolved.userId) {
    return failRedirect();
  }

  const userRow = await c.env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status FROM user WHERE id = ?`,
  )
    .bind(resolved.userId)
    .first<UserRow>();
  if (userRow && (userRow.deleted_at || userRow.status === 'deleted_soft')) {
    // The link holder controls the inbox: say why, as the Google path does.
    return c.redirect(`${c.env.APP_ORIGIN}/login?error=account_deleted`, 302);
  }
  if (!userRow || userRow.status === 'disabled') {
    return failRedirect();
  }

  // Single-use: claim the token before any side effect, so concurrent
  // consumes of one link mint at most one session.
  if (!(await consumeAuthToken(c.env, resolved.tokenHash))) {
    return failRedirect();
  }

  const now = Date.now();
  if (userRow.status === 'pending_verification') {
    // A magic link proves inbox control, not that this person chose the
    // password / profile on the pending account (see dropUnprovenSignupState).
    await dropUnprovenSignupState(c.env, userRow.id, userRow.email);
    await c.env.DB.prepare(`UPDATE user SET status = 'active', updated_at = ? WHERE id = ?`)
      .bind(now, userRow.id)
      .run();
  }

  const ip = clientIp(c.req.raw);

  // 2FA gate. A magic link proves control of the EMAIL factor, so email-method
  // (and org-required-unenrolled, which falls back to email) 2FA is already
  // satisfied and we sign the user straight in. An SMS-method user's second
  // factor is their phone, which the link does NOT prove — so challenge it,
  // mirroring the Google-OAuth hand-off: no session cookie here, redirect to
  // /login with the challenge token in the URL fragment.
  const twofa = await twofaRequirement(c.env, userRow.id);
  if (twofa.required && twofa.method === 'sms') {
    let challenge: Awaited<ReturnType<typeof startChallenge>>;
    try {
      challenge = await startChallenge(c.env, {
        user: { id: userRow.id, email: userRow.email },
        purpose: 'login',
        method: 'sms',
        ip,
      });
    } catch (err) {
      // A browser navigation, not an XHR: send the user back to /login with a
      // readable reason instead of a JSON error page.
      if (err instanceof TwilioVerifyError) {
        return c.redirect(`${c.env.APP_ORIGIN}/login?error=sms_unavailable`, 302);
      }
      throw err;
    }
    const frag = `twofa=${challenge.token}&method=${challenge.method}&dest=${encodeURIComponent(challenge.destination)}`;
    return c.redirect(`${c.env.APP_ORIGIN}/login#${frag}`, 302);
  }

  // Best-effort new-device security alert (before createSession so the just-
  // minted session doesn't mask the device as already-seen). Never throws.
  await maybeSendNewSigninAlert(c.env, userRow.id, c.req.header('User-Agent') ?? null, ip);

  const session = await createSession(c.env, {
    userId: userRow.id,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: userRow.id,
    subjectType: 'session',
    subjectId: userRow.id,
    action: 'session.login',
    metadata: { method: 'magic_link' },
    ip,
  });

  return c.redirect(`${c.env.APP_ORIGIN}/?welcome=1`, 302);
});

// ─── Password reset: request ───────────────────────────────────────────────
authRouter.post('/password-reset/request', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:pwreset:ip:${ip}`, limit: 6, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:pwreset:email:${body.email}`, limit: 4, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status !== 'deleted_soft') {
    const token = await createAuthToken(c.env, { kind: 'password_reset', userId: user.id });
    const link = `${c.env.APP_ORIGIN}/reset-password?token=${token}`;
    await sendPasswordReset(c.env, user.email, link);
  }

  return c.body(null, 204);
});

// ─── Password reset: confirm ───────────────────────────────────────────────
authRouter.post('/password-reset/confirm', async (c) => {
  const body = await parseJson(c, passwordResetConfirmSchema);

  const resolved = await resolveAuthToken(c.env, body.token, 'password_reset');
  if (!resolved || resolved.consumedAt || resolved.expiresAt <= Date.now() || !resolved.userId) {
    throw validationFailed('Invalid or expired token');
  }
  // Single-use: claim the token before changing anything.
  if (!(await consumeAuthToken(c.env, resolved.tokenHash))) {
    throw validationFailed('Invalid or expired token');
  }

  const userId = resolved.userId;
  const newHash = await hashPassword(body.password);
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT id FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE credential SET password_hash = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(newHash, now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
       VALUES (?, ?, 'password', ?, ?, ?)`,
    )
      .bind(ulid(), userId, newHash, now, now)
      .run();
  }

  await invalidateAuthTokensForUser(c.env, userId, 'password_reset');
  await revokeAllSessions(c.env, userId);

  await logAudit(c.env, {
    actorUserId: userId,
    subjectType: 'user',
    subjectId: userId,
    action: 'user.password_reset',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Logout ────────────────────────────────────────────────────────────────
authRouter.post('/logout', requireAuth, async (c) => {
  const session = c.var.session!;
  await revokeSession(c.env, session.id);
  await clearImpersonationBinding(c.env, session.id);
  c.header('Set-Cookie', clearSessionCookie());
  c.header('Set-Cookie', clearImpersonatorCookie(), { append: true });
  await logAudit(c.env, {
    actorUserId: session.userId,
    subjectType: 'session',
    subjectId: session.id,
    action: 'session.logout',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── Logout all ────────────────────────────────────────────────────────────
authRouter.post('/logout-all', requireAuth, async (c) => {
  const user = c.var.user!;
  await revokeAllSessions(c.env, user.id);
  await clearImpersonationBinding(c.env, c.var.session!.id);
  c.header('Set-Cookie', clearSessionCookie());
  c.header('Set-Cookie', clearImpersonatorCookie(), { append: true });
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'session',
    subjectId: user.id,
    action: 'session.logout_all',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});
