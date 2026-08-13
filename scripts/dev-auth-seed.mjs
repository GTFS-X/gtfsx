#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Seed a REAL user + session into the LOCAL wrangler D1, for local development.
//
//   npm run dev:auth                       # agency plan, dev@localhost.invalid
//   npm run dev:auth -- --plan free
//   npm run dev:auth -- --plan enterprise --staff
//   npm run dev:auth -- --email me@localhost.invalid --plan agency
//
// It prints a `VITE_DEV_SESSION_TOKEN=…` line; paste that plus
// `VITE_DEV_AUTH=server` into `.env.local` and restart `npm run dev`. The SPA
// installs the token as the session cookie and the local worker then
// authenticates you through the ordinary code path — no auth code is bypassed,
// stubbed, or weakened. `/api/*` works, saving works, publishing works.
//
// This talks ONLY to the miniflare-backed local D1 under `.wrangler/state`
// (`wrangler d1 execute --local`). There is no remote mode and no flag that
// adds one: minting a session is a local-only affair by construction, which is
// why this lives in a script rather than a worker route. Nothing in `worker/`
// changed to support it.
//
// Prereqs: `npx wrangler d1 migrations apply gtfs-builder --local` at least
// once, so the local DB has the `user` and `session` tables.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulidx';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_BINDING_NAME = 'gtfs-builder'; // wrangler.jsonc → d1_databases[0].database_name
const PLANS = ['free', 'agency', 'enterprise'];
const SESSION_DAYS = 30;

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let plan = 'agency';
let staff = false;
let email = 'dev@localhost.invalid';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--plan') plan = String(argv[++i] ?? '');
  else if (a === '--email') email = String(argv[++i] ?? '').trim().toLowerCase();
  else if (a === '--staff') staff = true;
  else if (a === '--help' || a === '-h') {
    console.log('Usage: npm run dev:auth -- [--plan free|agency|enterprise] [--staff] [--email you@localhost.invalid]');
    process.exit(0);
  } else {
    die(`Unknown argument "${a}".`, 'Run with --help for usage.');
  }
}

if (!PLANS.includes(plan)) die(`--plan must be one of ${PLANS.join(' | ')} (got "${plan}").`);
if (!/^[^\s@]+@[^\s@]+$/.test(email)) die(`--email is not an email address (got "${email}").`);

// ─── seed ────────────────────────────────────────────────────────────────────
const now = Date.now();
const token = randomBytes(32).toString('base64url'); // cookie-safe, 43 chars
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;

// Idempotent by email: re-running upgrades/downgrades the same account rather
// than colliding on the UNIQUE(email) index.
d1(`
  INSERT INTO user (id, email, display_name, status, staff, email_verified, plan, plan_status, created_at, updated_at)
  VALUES ('${ulid()}', '${sql(email)}', '${sql(displayNameFor(email))}', 'active', ${staff ? 1 : 0}, 1,
          '${plan}', 'active', ${now}, ${now})
  ON CONFLICT(email) DO UPDATE SET
    status = 'active', staff = ${staff ? 1 : 0}, email_verified = 1,
    plan = '${plan}', plan_status = 'active', deleted_at = NULL, updated_at = ${now};
`);

const userId = first(d1(`SELECT id FROM user WHERE email = '${sql(email)}'`))?.id;
if (!userId) die('Seeded the user row but could not read it back — is the local D1 migrated?');

d1(`
  INSERT INTO session (id, token_hash, user_id, ip, user_agent, created_at, last_used_at, expires_at)
  VALUES ('${ulid()}', '${tokenHash}', '${userId}', '127.0.0.1', 'dev-auth-seed', ${now}, ${now}, ${expiresAt});
`);

console.log(`
✔ Local D1 seeded — real user + real session (local only).

    email  ${email}
    plan   ${plan}${staff ? ' (staff)' : ''}
    id     ${userId}
    expires ${new Date(expiresAt).toISOString().slice(0, 10)} (${SESSION_DAYS} days)

Put these two lines in .env.local (gitignored), then restart \`npm run dev\`:

VITE_DEV_AUTH=server
VITE_DEV_SESSION_TOKEN=${token}

Run the worker too — the session only means anything to it:

    npx wrangler dev --port 8787 --local
`);

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run one SQL statement against the LOCAL D1 and return the result rows. */
function d1(sqlText) {
  let out;
  try {
    out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB_BINDING_NAME, '--local', '--json', '--command', sqlText.trim()],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? '/tmp/npm-cache-gtfsx' } },
    );
  } catch (err) {
    die('wrangler d1 execute failed.', String(err.stderr || err.stdout || err.message).trim());
  }
  // wrangler prefixes the JSON with human-readable lines; take from the first '['.
  const start = out.indexOf('[');
  if (start === -1) return [];
  try {
    return JSON.parse(out.slice(start))[0]?.results ?? [];
  } catch {
    return [];
  }
}

function first(rows) {
  return rows[0];
}

/** Escape a single-quoted SQL string literal. Inputs are also validated above. */
function sql(s) {
  return String(s).replace(/'/g, "''");
}

function displayNameFor(addr) {
  const local = addr.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? `${local[0].toUpperCase()}${local.slice(1)} (dev)` : 'Dev User';
}

function die(what, detail) {
  console.error(`\n✖ dev-auth-seed: ${what}`);
  if (detail) console.error(`  ${detail}`);
  console.error('');
  process.exit(1);
}
