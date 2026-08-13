// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DEV AUTH SWITCH — development builds only.
//
// Why this exists: signed-in-only and plan-gated UI (the Routes-panel "Import
// from another feed" button, every paywall overlay, the org/workspace surfaces)
// renders off `currentUser` and its `plan`. On a plain `npm run dev` there is
// no session, so those code paths never render and cannot be reviewed — a fix
// to one of them is unverifiable locally. This lets you pick a signed-in
// identity for the dev server.
//
// ── PRODUCTION SAFETY ────────────────────────────────────────────────────────
// Every exported function starts with `if (!import.meta.env.DEV) return …`.
// Vite replaces `import.meta.env.DEV` with the literal `false` in a production
// build, so the rest of each body is statically unreachable and esbuild drops
// it — along with every string constant below, which are all declared *inside*
// the guarded bodies precisely so they go with it. Nothing here is reachable
// from a deployed bundle even if `VITE_DEV_AUTH` is set in the build env.
//
// That claim is enforced, not asserted: `scripts/check-prod-bundle.mjs` greps
// every emitted chunk for DEV_AUTH_BUNDLE_MARKERS and fails `npm run build:prod`
// if any survives.
//
// Requires explicit opt-in on top of DEV — `VITE_DEV_AUTH` in `.env.local`
// (gitignored via `*.local`) — so it never fires just because someone ran
// `npm run dev`.
//
// See README → "Local development" → "Signing in locally" for usage and for
// the exact boundary of what this does and does not cover.
// ─────────────────────────────────────────────────────────────────────────────

import type { AuthedUser } from '../services/authApi';

export type DevPlan = 'free' | 'agency' | 'enterprise';

export type DevAuthMode =
  /** Switch off (production build, unset flag, or an unparseable value). */
  | { kind: 'off' }
  /**
   * Client-only: a synthetic `currentUser` is injected into the store and no
   * `/api/me` request is made. Client-side gating works; anything served by
   * the worker still 401s, because there is no session.
   */
  | { kind: 'client'; plan: DevPlan; staff: boolean; user: AuthedUser }
  /**
   * Server-backed: a REAL session row seeded into the local D1 by
   * `npm run dev:auth`. The token is installed as the session cookie and the
   * normal `/api/me` path runs — no synthetic user anywhere.
   */
  | { kind: 'server'; token: string };

// Declared without an initializer so it is side-effect-free and gets tree-shaken
// out of a production bundle along with the dead bodies that reference it.
let cachedMode: DevAuthMode | undefined;

/**
 * Resolve the dev-auth switch. Pure apart from a one-time console warning on a
 * malformed value, and memoized so repeat callers don't re-warn.
 *
 * Accepted `VITE_DEV_AUTH` values:
 *   free | agency | enterprise   — client-only synthetic user of that plan
 *   <plan>+staff                 — …with the staff flag set (unlocks /admin UI)
 *   server                       — use VITE_DEV_SESSION_TOKEN against local D1
 *
 * Anything else fails closed (returns `off`) rather than guessing.
 */
export function readDevAuth(): DevAuthMode {
  // ── PRODUCTION GUARD — see the header comment. Do not move or soften. ──
  if (!import.meta.env.DEV) return { kind: 'off' };

  if (cachedMode) return cachedMode;

  const raw = ((import.meta.env.VITE_DEV_AUTH as string | undefined) ?? '').trim().toLowerCase();
  if (!raw) {
    cachedMode = { kind: 'off' };
    return cachedMode;
  }

  const token = ((import.meta.env.VITE_DEV_SESSION_TOKEN as string | undefined) ?? '').trim();

  if (raw === 'server') {
    if (!token) {
      console.warn(
        '[dev-auth] VITE_DEV_AUTH=server needs VITE_DEV_SESSION_TOKEN too. ' +
          'Run `npm run dev:auth` to seed a local session and paste the line it prints ' +
          'into .env.local. Dev auth is OFF.',
      );
      cachedMode = { kind: 'off' };
      return cachedMode;
    }
    cachedMode = { kind: 'server', token };
    return cachedMode;
  }

  const parts = raw.split('+');
  const plan = parts[0];
  const flags = parts.slice(1);

  if (plan !== 'free' && plan !== 'agency' && plan !== 'enterprise') {
    console.warn(
      `[dev-auth] Unrecognized VITE_DEV_AUTH value "${raw}". ` +
        'Expected free | agency | enterprise (optionally "+staff"), or "server". Dev auth is OFF.',
    );
    cachedMode = { kind: 'off' };
    return cachedMode;
  }

  const unknownFlags = flags.filter((f) => f !== 'staff');
  if (unknownFlags.length > 0) {
    console.warn(
      `[dev-auth] Unrecognized VITE_DEV_AUTH flag(s): ${unknownFlags.join(', ')}. ` +
        'Only "+staff" is supported. Dev auth is OFF.',
    );
    cachedMode = { kind: 'off' };
    return cachedMode;
  }

  const staff = flags.includes('staff');
  cachedMode = {
    kind: 'client',
    plan,
    staff,
    user: {
      // Deliberately unmistakable, and an unroutable RFC-6761 .invalid domain,
      // so this identity can never be confused with a real account and can
      // never receive mail. Also the marker string the prod-bundle check greps
      // for — keep it in sync with scripts/check-prod-bundle.mjs.
      id: 'dev-auth-local-user',
      email: 'dev-auth@gtfsx.invalid',
      displayName: staff ? 'Dev Auth (staff)' : 'Dev Auth',
      status: 'active',
      staff,
      plan,
      planStatus: 'active',
      // On `free`, leave the no-card trial unconsumed so the trial CTA is
      // reviewable; on a paid plan the trial is moot.
      trialUsed: plan !== 'free',
    },
  };
  return cachedMode;
}

/**
 * Install the seeded session token as the session cookie so the local worker
 * authenticates the browser normally.
 *
 * The real cookie is `HttpOnly`, which JavaScript cannot set. Locally that
 * costs nothing: the worker reads the raw `Cookie` header and never inspects
 * cookie attributes. Refuses to run anywhere but a loopback origin.
 */
export function installDevSessionCookie(token: string): void {
  // ── PRODUCTION GUARD — see the header comment. Do not move or soften. ──
  if (!import.meta.env.DEV) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    console.warn(`[dev-auth] Refusing to install a dev session cookie on non-loopback host "${host}".`);
    return;
  }

  // Mirrors SESSION_COOKIE in worker/auth/session.ts. Not imported: worker/ and
  // src/ are separate TS projects with separate runtimes.
  document.cookie = `gb_session=${token}; Path=/; SameSite=Lax; Max-Age=86400`;
}

/** Minimal structural view of the app store, to avoid importing it (cycle-free). */
export interface DevAuthBadgeStore {
  getState: () => { currentUser: AuthedUser | null; authChecked: boolean };
  subscribe: (listener: () => void) => () => void;
}

/**
 * Mount the persistent "DEV AUTH" badge and keep its text in sync with the
 * store, so a fake session is never mistaken for a real one mid-debug. The
 * badge states which mode is live and, in server mode, whether the local
 * worker actually accepted the session.
 *
 * Built imperatively rather than as a React component on purpose: it keeps the
 * whole thing (markup, styles, copy) inside one guarded function body, which is
 * what makes the production strip-out provable, and keeps dev scaffolding out
 * of the component tree.
 *
 * Returns an unsubscribe/unmount function (a no-op when the switch is off).
 */
export function startDevAuthBadge(store: DevAuthBadgeStore): () => void {
  // ── PRODUCTION GUARD — see the header comment. Do not move or soften. ──
  if (!import.meta.env.DEV) return () => {};

  const mode = readDevAuth();
  if (mode.kind === 'off') return () => {};
  if (typeof document === 'undefined' || !document.body) return () => {};

  const el = document.createElement('div');
  el.id = 'gtfsx-dev-auth-badge';
  el.dataset.testid = 'dev-auth-badge';
  el.title = 'GTFS·X local dev auth switch — set by VITE_DEV_AUTH in .env.local. Never present in a production build.';
  Object.assign(el.style, {
    position: 'fixed',
    left: '8px',
    bottom: '8px',
    zIndex: '2147483647',
    padding: '4px 9px',
    borderRadius: '9999px',
    font: '600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    letterSpacing: '0.02em',
    color: '#fff',
    boxShadow: '0 1px 4px rgba(0,0,0,.35)',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);

  const render = () => {
    const { currentUser, authChecked } = store.getState();
    if (mode.kind === 'client') {
      el.style.background = '#b45309'; // amber-700 — fake identity
      el.textContent = `DEV AUTH · fake ${mode.plan}${mode.staff ? '+staff' : ''} user · client-only (server calls 401)`;
      return;
    }
    if (currentUser) {
      el.style.background = '#166534'; // green-800 — real local session
      el.textContent = `DEV AUTH · local session · ${currentUser.email} · ${currentUser.plan ?? 'free'}${currentUser.staff ? '+staff' : ''}`;
      return;
    }
    el.style.background = '#991b1b'; // red-800 — token present but not working
    el.textContent = authChecked
      ? 'DEV AUTH · local session REJECTED · re-run `npm run dev:auth`'
      : 'DEV AUTH · local session · checking…';
  };

  render();
  const unsubscribe = store.subscribe(render);
  return () => {
    unsubscribe();
    el.remove();
  };
}
