# Google Ads Offline Conversion Import (OCI)

Server-side conversion uploader that pushes click-id-stamped events from the
`event` table — **four kinds**: `feed_exported`, `paywall_view`, `demo_request`,
`sign_up` — to Google Ads via the **Data Manager API**
([`events:ingest`](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest)).
Cookieless replacement for the standard `gtag.js` conversion pixel.

> **The legacy [`uploadClickConversions`](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks)
> endpoint is de-allowlisted for this account** and returns
> `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` (re-confirmed live 2026-08-08).
> The code keeps it only as a loud-on-failure fallback for when the Data Manager
> secrets are absent. Do not migrate back to it.

A row carries `gclid`, `gbraid` or `wbraid`. Where we also hold a hashed
customer email it rides along as a `userData` user identifier — see
[User identifiers](#user-identifiers-hashed-email) below.

Code: `worker/marketing/ads/oci.ts` (+ `userIdentifiers.ts`). Cron: `0 9 * * *`
(09:00 UTC ≈ 03:00 MT) in `wrangler.jsonc`. Status page:
`/api/admin/events/oci-status`. One-shot diagnostic:
`npx tsx scripts/oci-diagnose.ts` (validate-only / read-only by default).

---

## One-time setup — complete (kept as a runbook)

All secrets and conversion actions below exist in prod as of 2026-07-12.
Until every secret below is set in Cloudflare, the uploader logs
`[oci] skipped — env not configured` and exits cleanly. So the cron is
safe to ship before secrets exist; it just won't do anything.

### 1. Google Ads developer token

1. Visit https://ads.google.com/aw/apicenter under `mark@eateggs.com`.
2. Apply for a developer token. Test-level may auto-approve; basic-level
   needs Google review (1–3 business days).
3. Copy the token string.

### 2. Google Cloud project + OAuth client

1. Create a project at https://console.cloud.google.com (e.g. `gtfsx-ads-oci`).
2. Enable the **Google Ads API** in APIs & Services → Library.
3. APIs & Services → Credentials → Create OAuth 2.0 Client ID:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:8080`
4. Note the **Client ID** and **Client secret**.

### 3. Obtain the long-lived refresh token (one-time, local)

Run this snippet on your laptop. It launches a one-time browser flow that
grants the Google Ads API scope, then prints the refresh token to stdout.

```bash
# scripts/oci-bootstrap.sh — not in the repo; paste into a scratch file.
python3 <<'EOF'
import http.server, socketserver, urllib.parse, webbrowser, json, urllib.request

CLIENT_ID = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com"
CLIENT_SECRET = "PASTE_CLIENT_SECRET_HERE"
SCOPE = "https://www.googleapis.com/auth/adwords"
PORT = 8080
REDIRECT = f"http://localhost:{PORT}"

auth_url = (
    "https://accounts.google.com/o/oauth2/v2/auth"
    f"?client_id={CLIENT_ID}&redirect_uri={REDIRECT}&response_type=code"
    f"&scope={SCOPE}&access_type=offline&prompt=consent"
)

print("Open this URL in your browser, approve the GTFS·X Google Ads API access, then return here:")
print(auth_url)
webbrowser.open(auth_url)

code_holder = {}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.urlparse(self.path).query
        code_holder["code"] = urllib.parse.parse_qs(q).get("code", [None])[0]
        self.send_response(200); self.end_headers()
        self.wfile.write(b"OK — return to terminal.")
    def log_message(self, *a): pass

with socketserver.TCPServer(("", PORT), H) as srv:
    while "code" not in code_holder:
        srv.handle_request()

req = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code_holder["code"],
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode(),
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)
print(json.dumps(json.loads(urllib.request.urlopen(req).read()), indent=2))
EOF
```

The printed JSON includes `refresh_token` — save it somewhere safe. It
does not expire unless you revoke it manually.

### 4. Conversion action IDs

Four conversion actions map to the four uploaded event kinds:

| Name | Category | Event kind | Status |
|---|---|---|---|
| `feed_exported` | Converted lead | `feed_exported` | exists (created 2026-05-26) |
| `paywall_view` | Qualified lead | `paywall_view` | exists (created 2026-05-26) |
| `demo_request` | Book appointment | `demo_request` (POST `/api/demo-leads`, the /book-demo lead-form submit) | exists (created 2026-07-12, ctId 7682006138) |
| `sign_up` | Sign-up | `sign_up` (POST `/auth/signup`, fresh account signup carrying an ad click id) | needs creation (see §4) |

> **`demo_request` now fires on the lead-form submit, not a redirect click.**
> `/book-demo` used to 302 straight to the booking calendar and count the
> conversion on that redirect. It now serves a lead form; the conversion is
> emitted when the visitor submits it (POST `/api/demo-leads` →
> `insertEvent('demo_request', …)`). Deliberate consequence: reported
> conversion volume drops (a form submit is a higher bar than a redirect
> click), but signal quality rises, so Google Ads optimizes on genuine intent
> rather than every outbound click. The event name, gclid stamping, and
> conversion action are unchanged, so the uploader needs no changes.

Get each ID by: Goals → Summary → click the action → look at the URL,
which contains `&ctId=NNNNNNNNNNN`. That number is the conversion action ID.

#### Creating the `demo_request` conversion action (one-time, Ads UI)

**Done 2026-07-12** (ctId 7682006138; secret set on prod). Steps kept below
for reference if the action ever needs to be recreated.

1. In Google Ads (`mark@eateggs.com`): **Goals → Conversions → Summary →
   "+ New conversion action"**.
2. Choose **Import** → **CRMs, files, or other data sources** →
   **Track conversions from clicks** → Continue. (This is the same import
   type as the two existing actions — the uploader sends the click's gclid,
   not a website tag.)
3. Settings:
   - **Goal and action optimization:** Book appointment (or Submit lead
     form — any lead-type category works; the name is what matters for
     humans, the numeric ID is what the uploader uses).
   - **Conversion name:** `demo_request` — keep it identical to the event
     kind so the Ads UI, the admin status page, and the D1 rows all speak
     the same name.
   - **Value:** *Don't use a value.* (The uploader deliberately omits
     `conversion_value`; a value here would flip the action to value-based
     mode.)
   - **Count:** One. (A visitor who clicks the booking link twice is still
     one demo request.)
   - **Click-through conversion window:** 90 days (matches the uploader's
     gclid TTL).
4. Save, then fetch the numeric ID: Goals → Summary → click `demo_request`
   → copy the `&ctId=NNNNNNNNNNN` number from the URL.
5. Store it (prod, and staging if desired):

   ```bash
   wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST   # numeric ID
   ```

**If this secret is ever unset, `demo_request` uploads go OFF but everything
else keeps working**: unlike the two original action IDs, this one is
optional in `readOciConfig`, so the live `feed_exported`/`paywall_view`
uploads are unaffected. Pending `demo_request` rows accumulate (visible on
`/api/admin/events/oci-status`, which shows a yellow note while the secret
is missing) and upload on the first cron run after it's set — rows older
than 90 days are expired, same as the other kinds.

#### Creating the `sign_up` conversion action (one-time, Ads UI)

Same procedure as `demo_request` above — create an **Import → Track
conversions from clicks** action named `sign_up` (category **Sign-up**,
*Don't use a value*, Count **One**, 90-day window), then store its numeric ID:

```bash
wrangler versions secret put GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP   # numeric ID
```

The `sign_up` event is written server-side by the `/auth/signup` fresh-signup
path (`insertEvent('sign_up', …)`) — only when the signup carried a captured
ad click id (gclid/gbraid/wbraid), and only on a genuinely fresh signup (never
on a login or a pending-verification retry). Organic signups write nothing.
This secret is **optional** in exactly the same way as `demo_request`: leave it
unset and the other three kinds keep uploading while `sign_up` rows stay
pending (yellow note on the admin status page) until it's set.

### 5. Store everything as Worker secrets

```bash
# Prod (gtfs-builder)
wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
wrangler secret put GOOGLE_ADS_CLIENT_ID
wrangler secret put GOOGLE_ADS_CLIENT_SECRET
wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
wrangler secret put GOOGLE_ADS_CUSTOMER_ID            # <your-customer-id> (no hyphens)
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED   # numeric ID
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW    # numeric ID
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST    # numeric ID (optional — see §4)
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP         # numeric ID (optional — see §4)
```

**Local `.env` / `.dev.vars` are INCOMPLETE relative to prod.** As of
2026-08-08 the local files hold neither
`GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST` nor
`GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP`, both of which *are* set as prod Worker
secrets. So anything run locally (the diagnostic, an ad-hoc script) resolves
only `feed_exported` + `paywall_view` and **silently skips the other two kinds**
— the skip looks identical to "those kinds have nothing pending". Copy both
values out of the prod secrets before drawing any conclusion about
`demo_request` or `sign_up` locally. `scripts/oci-diagnose.ts` prints a
`PROD-ONLY (this script cannot exercise these)` line naming exactly which
secrets are missing locally; read it before trusting the rest of the run.

The cron triggers automatically at 09:00 UTC the next day. To smoke-test
sooner, hit the manual trigger:

```bash
curl -X POST -b "$COOKIE" https://www.gtfsx.com/api/admin/events/oci-run
```

(Or visit `/admin/events/oci-status` in the UI — it has a "Run upload now"
button.) The first successful conversion typically appears in Google Ads UI
under Goals → Summary within ~3 hours.

---

## Data Manager API migration (2026-07)

**Why:** around 2026-06-22 Google de-allowlisted this account from the legacy
`ConversionUploadService.UploadClickConversions` endpoint. Every upload now
returns `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` → *"New integrations for
uploading click conversions should use the Data Manager API."* This is not a
version or credential problem (verified across API versions v21–v24); the
endpoint is simply closed to us. The supported replacement is the **Data Manager
API** (`datamanager.googleapis.com`).

The uploader now takes the Data Manager path automatically once its two secrets
are set (`GOOGLE_DATAMANAGER_REFRESH_TOKEN` + `GOOGLE_DATAMANAGER_PROJECT_ID`);
until then it uses the legacy path, which is dead but now *fails loudly* (emails
the owner, marks rows failed) instead of silently marking rejections as
uploaded. The Data Manager path also uploads `gbraid`/`wbraid` clicks, not just
`gclid`.

**What's different from the legacy path:** no developer token and no
`login-customer-id` header — the login/manager account and the conversion action
are carried in the request body. It reuses the existing OAuth client
(`GOOGLE_ADS_CLIENT_ID`/`SECRET`), but the refresh token must be minted with the
`https://www.googleapis.com/auth/datamanager` scope (the current one is
adwords-scoped and won't work), and every request sends an `x-goog-user-project`
header naming the Cloud project.

### OAuth runbook (the part that needs Mark)

Everything except the account grant is a repeat of the original setup with a new
scope. The user `mark@eateggs.com` already owns the Ads account, so no extra
access grant is needed.

1. **Enable the API.** In the SAME Google Cloud project that holds the OAuth
   client (created in §2 above, e.g. `gtfsx-ads-oci`): APIs & Services → Library
   → search **"Data Manager API"** → **Enable**.
2. **Note the project ID.** Cloud console → project picker (or the dashboard
   "Project ID", e.g. `gtfsx-ads-oci`). This is `GOOGLE_DATAMANAGER_PROJECT_ID`.
3. **Mint the refresh token** with the datamanager scope. Run the SAME bootstrap
   snippet as §3 above, reusing the same `CLIENT_ID`/`CLIENT_SECRET`, with only
   the scope changed:

   ```python
   # ...identical to the §3 snippet, but:
   SCOPE = "https://www.googleapis.com/auth/datamanager"
   ```

   Approve the consent screen; copy the printed `refresh_token`.
4. **Hand it off.** Paste both values into `.dev.vars` (Claude will
   `wrangler secret put` them to prod):

   ```
   GOOGLE_DATAMANAGER_REFRESH_TOKEN=<the refresh_token from step 3>
   GOOGLE_DATAMANAGER_PROJECT_ID=<the project id from step 2>
   ```

5. **Verify + backfill** (Claude/owner, after the secrets land): the admin OCI
   status page (`/api/admin/events/oci-status`) should show *"Uploading via the
   Data Manager API"*. Hit **Run upload now** to smoke-test, confirm the run
   reports uploads (not failures), then **Requeue rejected conversions** to
   re-send the rows that were wrongly marked uploaded during the outage (safe —
   Google de-dupes by `transactionId`).

**Manager account (`loginAccount`).** The uploader includes
`destinations[].loginAccount` from `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (a prod secret)
when present. If a `validateOnly` test ever reports the login/manager account is
wrong or unnecessary, adjust or unset that secret — the operating account
(`GOOGLE_ADS_CUSTOMER_ID`) is always sent.

---

## User identifiers (hashed email)

Added 2026-08. Alongside the ad click id, an event may carry
`userData.userIdentifiers[].emailAddress` — the SHA-256 of the customer's
normalized email, hex-encoded. Google uses it to attribute conversions the click
id alone can't: cross-device journeys, iOS/consent-limited clicks, and clicks
whose `gclid` never made it back to us.

**Contract** (`worker/marketing/ads/userIdentifiers.ts`):

- `userData` is a **sibling of `adIdentifiers`**, not nested inside it. Max 10
  identifiers per event; we send exactly one.
- The value is `hex(sha256(normalized_email))`. No `encryptionInfo` / KMS — that
  is a separate, optional feature we do not use.
- Top-level **`encoding: "HEX"` becomes required** the moment any event in the
  request carries `userData`. It is omitted when none does, so a click-id-only
  request is byte-identical to what shipped before this change.
- Normalization: trim, lowercase; then **only** for `gmail.com` /
  `googlemail.com`, drop the `+tag` and strip dots from the local part. Every
  other domain keeps its dots and `+` (case-folding only).
- An event with **neither** an ad identifier nor a user identifier is a hard
  failure (`NO_IDENTIFIERS_PROVIDED`); `buildIngestBody` refuses to construct one.

### Where the email comes from, per kind

The `event` table stores **no user id and no plaintext address** — that is the
locked cookieless design. So the hash is computed at INSERT time by whichever
code path already holds the address, and only the digest is stored
(`event.oci_email_sha256`, migration 0032).

| Kind | Source of the address | Coverage |
|---|---|---|
| `sign_up` | The account email, from `POST /auth/signup` and the new-user branch of `/auth/google/callback`. | Always — a signup by definition has one. |
| `demo_request` | The lead's own address on the `/book-demo` form (`POST /api/demo-leads`). Plaintext stays in `demo_leads`, as before. | Always. The most reliable identifier of the four: typed by the requester, on the form that *is* the conversion. |
| `feed_exported` | `c.var.user.email`, if the `/api/events/track` call carries a session. | **None today** — see below. |
| `paywall_view` | Same as above. | **None today** — see below. |

**The gap, stated plainly: `paywall_view` and `feed_exported` resolve no email
at all, and that is now a settled decision rather than an open question.** They
come from the SPA's analytics beacon, and `src/services/trackBeacon.ts` sends
`credentials: 'omit'` — deliberately, so the ingest endpoint never sees a
session. `sessionMiddleware` therefore leaves `c.var.user` undefined and those
rows upload on their click id alone. The server-side branch that would stamp a
hash is in place and tested, but it is unreached from a real browser.

### The beacon stays cookieless — decided 2026-08-08, do not "fix" it

Closing that gap means **attaching credentials to the analytics beacon**, which
would let the server correlate every page view with an account. That was
reviewed and **declined**:

- it contradicts the locked cookieless design and `public/privacy-policy` §3.5's
  promise that page views aren't correlated across sessions;
- the measurable upside is near zero at current volume — **12 paid paywall views
  in 30 days**, so a better match rate on those clicks buys almost nothing;
- it is a privacy-policy change, not a match-rate optimization.

(Hashing client-side instead was considered and rejected separately: the
endpoint is public and unauthenticated, so it would let anyone forge conversions
carrying someone else's hashed email.)

The constraint is recorded at the `credentials: 'omit'` line in
`src/services/trackBeacon.ts` so the next reader sees why it is there and what
it costs before changing it.

Net: user identifiers cover `sign_up` and `demo_request`, permanently. Those are
also the two highest-intent conversions, so it is the useful half of the funnel —
but do not read "hashed email attached" as covering paywall views. This is also
why those two kinds, and only those two, can ever be uploaded on an email alone
(see [Draining the organic backlog](#draining-the-organic-backlog-google_ads_upload_without_click_id_kinds)).

Non-conversion kinds (`page_view`, `editor_loaded`, `cta_click`) are **never**
stamped: there is nothing to upload them to, so there is no reason to attach an
identifier.

### The privacy policy now covers this (corrected 2026-08-08)

`public/privacy-policy` used to state, twice, that we **"don't share [data] with
advertisers"** (§1 and §5), listed no Google entry in the §5 vendor table, and
described the `event` table in §3.5 as purely aggregated cookieless analytics.
None of that accounted for uploading conversion data to Google Ads, which has
been happening since 2026-05 — the gap predated the hashed email and was made
worse by it, since a hashed email is a hashed *direct identifier* of a person,
not just a click token.

Corrected on the owner's instruction:

- **§1** bullet 4 no longer claims we share nothing with advertisers; it points
  at §3.9.
- **§3.5** now says conversion events additionally carry the ad click identifier
  and (for signups / demo requests) the hashed email, and cross-references §3.9.
  The "no tracking cookies / no fingerprinting / no cross-session correlation of
  page views" promise is unchanged and still true: `page_view` rows are never
  stamped with a hash (`CONVERSION_KINDS` in `worker/events/routes.ts`).
- **§3.9 "Conversion measurement"** is new and describes the whole mechanism.
- **§4** notes the click identifier lives in `sessionStorage`, not a cookie.
- **§5** has a Google Ads vendor row and a corrected closing sentence.
- **§7** says the hash is cleared automatically when the account is hard-purged,
  and names the residue that isn't reached — see "Deletion" below.

**Keep the policy true if you change the code.** In particular: enabling
`GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS` is *already* covered by §3.9's
wording, but adding a fifth conversion kind, a conversion value, or a second
user identifier is not.

**Deletion — automatic, as of this change.** `event` has no `user_id`, so the
only thing a delete can key on is the digest itself. Step 0 of `reapOne`
(`worker/cron/tasks.ts`) reads the reaped user's address *before* the `user` row
is dropped, recomputes the digest with the same `hashEmailHex` the write paths
use, and runs `UPDATE event SET oci_email_sha256 = NULL WHERE oci_email_sha256 = ?`.
The count lands on `ReapSummary.conversionHashesCleared` and in the reaper log
line.

Three things to keep true if you touch this:

- **Use the shared `hashEmailHex`, never a local re-implementation.** It owns
  Google's normalization. A reaper that normalized differently would match zero
  rows and purge nothing *while appearing to succeed* — the worst failure mode
  available here. `cron.reaper.test.ts` guards it end-to-end: it signs a user up
  through `POST /auth/signup` (the real write path) and asserts the reaper's
  computation clears the row, so the two can never drift apart silently.
- **Nothing that needs the address may run after step 5** (`DELETE FROM user`).
- **A purged row leaves the candidate set by itself.** `candidateSql`'s
  email-only disjunct is gated on `oci_email_sha256 IS NOT NULL`, so a row that
  loses its hash and has no click id is simply never selected again — no further
  attempts, no `-1` sentinel needed. That is a dependency, not a coincidence:
  widening that predicate would turn purged rows into permanently
  un-uploadable candidates that burn a retry every night.

What deletion does **not** reach: a hash of an address the account no longer
holds — a `demo_request` submitted from a *different* email, or an address the
user changed away from via `/api/me/change-email` (the hash was stamped against
the old one). §7 of the privacy policy states that residue plainly and routes it
to `support+privacy@gtfsx.com`.

Also untouched, and deliberately so, is the **plaintext address in
`demo_leads`** — a durable record of a sales enquiry, not an account artifact,
and not necessarily the same person as the account being reaped. Deleting it on
account deletion has never been decided either way; note that the policy does
not currently describe `demo_leads` as a collected category at all, so if we do
start reaching it (or explicitly decide not to), §3 needs a line about it.

### The customer-data terms gate (live as of 2026-08-08)

The destination account has **not** accepted Google's customer-data terms and
enhanced conversions for leads is **off**, so a `userData`-bearing event is
rejected:

```
HTTP 400 INVALID_ARGUMENT
  error.details[].fieldViolations[]:
    field:  events.events[0].destination_references[0]
    reason: DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED
```

Naively adding `userData` would therefore have turned every currently-succeeding
upload into a 400 — a regression, not a fix. Instead the uploader:

1. sends the event **with** `userData` when the row has a hash;
2. on rejection, reads the **structured `reason` token** (never the message
   text, never the bare 400) and, if it is one of
   `DESTINATION_ACCOUNT_ENHANCED_CONVERSIONS_TERMS_NOT_SIGNED`,
   `TERMS_AND_CONDITIONS_NOT_SIGNED`,
   `DESTINATION_ACCOUNT_DATA_POLICY_PROHIBITS_ENHANCED_CONVERSIONS`,
   re-sends the identical event **without** `userData` — same `transactionId`,
   so no double-count risk;
3. treats the retry's outcome as the row's outcome.

Any *other* 400 still fails the row, as before. The result: today the pipeline
behaves exactly as it did, and **the moment Mark accepts the terms, hashed
emails start flowing with no code change and no deploy**.

The fallback logs **once per run** (not once per row) and the run summary
carries `userDataFallbacks`; a non-zero value is the standing signal that the
terms are still outstanding.

**To turn user identifiers on** (a UI click, not an engineering task): Google
Ads → **Goals → Conversions → Summary →** a conversion action **→ Settings →
Enhanced conversions for leads**, tick it, and accept both boxes in the terms
dialog ("Google's EU user consent policy" + "Customer data policies"). Then
re-run `npx tsx scripts/oci-diagnose.ts` — probe A2 should return 200 instead of
the 400 above.

---

## Email-only uploads (`GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS`)

Attaching a hashed email makes a row *without* a click id uploadable for the
first time. **That is a much bigger change than it looks**, so it is a
capability, off by default, and **scoped per conversion kind**.

### Which kinds can ever qualify — and why it isn't a setting

`EMAIL_ONLY_ELIGIBLE_KINDS` in `oci.ts` is a **hard ceiling of two**:

| Kind | Email-only candidacy | Why |
|---|---|---|
| `sign_up` | possible, but **vacuous today** | The account email is always available server-side — but the event is only *written* when the signup carried a click id (`auth/routes.ts`, `auth/google.ts`), so no click-id-less `sign_up` row can exist to widen to. Eligible because that gate is a product decision that could change, not a law. |
| `demo_request` | possible, and **the only one that bites** | The lead's own address, on the form that *is* the conversion. `demoLead.ts` writes the event unconditionally, so a form submit with no click id is a real, uploadable row. |
| `paywall_view` | **impossible** | Beacon-emitted, `credentials: 'omit'` ⇒ no email ever. |
| `feed_exported` | **impossible** | Same. |

A `paywall_view` or `feed_exported` row with no click id has **no identifier at
all** — not a click id, not an email — so it can never be uploaded whatever any
flag says; Google would answer `NO_IDENTIFIERS_PROVIDED`. Those rows are
excluded at **selection** (`candidateSql`'s email-only disjunct requires both
`oci_email_sha256 IS NOT NULL` and an eligible `kind`), not attempted and failed,
and `buildIngestBody` refuses to construct a no-identifier event as a second
tripwire. Both are covered by tests.

Naming `paywall_view` or `feed_exported` in the env var does **not** enable them:
the token is dropped with a warning. That matters because a `paywall_view` *can*
acquire a hash in principle — `/api/events/track` stamps one for any credentialed
caller — and without the kind conjunct such a row would upload as a "conversion"
on the strength of a page view.

### The two settings, and both are required

- `GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS` — a comma-separated subset of the
  eligible kinds (`sign_up`, `demo_request`), or `*` for both. Unset or empty ⇒
  **off for every kind**, which is the default and the shipped state.
- `GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_SINCE=<unix ms | ISO 8601>` — a
  **mandatory** cutover. Only email-only rows *newer* than this are ever
  considered. Kinds named with no cutover ⇒ the capability stays **off** and
  logs a warning, so naming a kind can never retroactively drain history.

`markExpiredOnly` deliberately still ignores email-only rows, so arming the
capability can't stamp the `-1` sentinel across historical rows either.

### What is actually in the backlog (measured 2026-08-08, prod D1)

Conversion-kind rows with **no** `gclid`/`gbraid`/`wbraid`, all pending:

| Kind | Rows, no click id | Date range | Could email-only reach them? |
|---|---:|---|---|
| `paywall_view` | 2,075 | 2026-05-21 → 2026-08-08 | No — ineligible kind |
| `feed_exported` | 546 | 2026-05-21 → 2026-08-08 | No — ineligible kind |
| `demo_request` | 106 | 2026-07-12 → 2026-07-20 | No — no hash on any of them |
| **Total** | **2,727** | | **0 rows** |

**So the real answer today is zero.** Migration 0032 adds `oci_email_sha256` as
`NULL` and nothing backfills it, so not one existing row carries a hash. Earlier
wording here implied flipping the flag would dump ~2,727 rows (≈90× the 30 rows
ever uploaded) into the live account; that was wrong in a way worth correcting,
because the true hazard is *future* rows, not the backlog. Use the
`eligible_with_hash` column in `npx tsx scripts/oci-diagnose.ts` to re-check the
number rather than reasoning from this table.

> ⚠️ **Those 106 `demo_request` rows are not demo requests.** Until 2026-07-13 the
> event fired on `GET /book-demo` — the redirect click — so crawlers walking every
> `/book-demo?src=…` link on a marketing page generated bursts of them (12 rows
> in 4 seconds on 2026-07-12 17:08, one per placement, with distinct `src`
> labels). Since commit `8a040fb` the event fires on the form **submit** (POST
> `/api/demo-leads`), and prod bears that out: 5 `demo_leads` rows and 5
> post-cutover `demo_request` events, 1:1. **Uploading the pre-2026-07-13 rows as
> conversions would be feeding Google Ads crawler traffic.** They carry no hash
> so they cannot become candidates, but set any cutover after 2026-07-13 anyway.

### The deliberate, bounded drain

For a decision made on purpose later, there is a staff-only endpoint. It is
**dry-run by default** and has **no unbounded mode**:

```bash
# Dry run — counts candidates, sends nothing, writes nothing:
curl -X POST -b "$COOKIE" -H 'X-GB-Client: web' \
  'https://www.gtfsx.com/api/admin/events/oci-backfill?from=2026-08-01&to=2026-08-08'

# Actually send (BOTH params required), capped at `limit` rows:
curl -X POST -b "$COOKIE" -H 'X-GB-Client: web' \
  'https://www.gtfsx.com/api/admin/events/oci-backfill?from=2026-08-01&to=2026-08-08&limit=50&dryRun=false&confirm=send'
```

`from` and `to` are mandatory; `limit` defaults to 100 and is hard-capped at
500; every run writes an `admin.oci.backfill` audit row. **This has not been
run.** Start with a dry run, look at `candidates`, and decide.

The endpoint is unchanged, but it inherits the same per-kind ceiling: an
explicit backfill widens candidacy for `sign_up` and `demo_request` only, never
for `paywall_view` / `feed_exported`. It would otherwise be a way to route
around the scoping, and the rows it would reach have no identifier anyway.

---

## Alerting and the per-run summary

Every run logs one `[oci] run summary` line: candidates, attempted, uploaded,
failed, permanently failed, expired, `withUserData`, `userDataFallbacks`, the
top structured error reasons, and any kinds pending with no conversion action.
Sample identifiers in logs are redacted to a short prefix — a full digest is
never logged.

At most **one email per run** (never one per row), from both the cron *and* the
admin "Run upload now" button. It fires when:

| Condition | Why it used to be silent |
|---|---|
| Rejected or permanently-failed rows | (already alerted) |
| `configured: false` on prod | A rotated-away secret produced only a `console.warn` — the uploader stopped uploading and nothing said so. |
| A kind has pending rows but **no conversion action id** | Its rows are never selected, so `attempted` stayed 0 and no alert could fire however many piled up. |

A deliberate skip (non-production origin) and a dry run never alert.

---

## Operational notes

- **Idempotency.** Once a row is uploaded, `event.oci_uploaded_at` is set to
  the unix-ms timestamp of the upload. The pending-rows query filters on
  `oci_uploaded_at IS NULL`, so the same conversion never goes up twice.
- **90-day gclid TTL.** Google rejects gclids older than ~90 days, so rows
  past that cutoff are marked with the sentinel `oci_uploaded_at = -1` and
  `oci_last_error = 'expired (>90 days)'` instead of being sent.
- **Per-row failures.** The Data Manager path sends **one event per request**,
  so the HTTP status *is* the per-row verdict — there is no hidden per-row
  rejection channel. (The legacy fallback instead uses `partial_failure: true`
  and decodes `partialFailureError`.) On a rejection we increment
  `oci_attempts` and store the error in `oci_last_error`. Once
  `oci_attempts >= 3` the row is marked permanently failed
  (`oci_uploaded_at = -1`) so it stops being retried — check the admin page and
  investigate.
- **Token rotation.** If the refresh token is revoked (e.g. password reset
  for `mark@eateggs.com`, scope change in Google security settings) the
  uploader will start returning OAuth `invalid_grant` errors. Re-run the
  bootstrap snippet above and `wrangler secret put GOOGLE_ADS_REFRESH_TOKEN`
  with the new value.

## What this module does NOT do

- **No GA4 / gtag.js / any client-side analytics.** The whole point of OCI
  is to keep all conversion tracking server-side. Don't add a pixel.
- **No bid-strategy switch.** The campaign stays on Maximize Clicks until
  Mark manually flips it to Maximize Conversions in the Ads UI, which
  should only happen after ≥30 conversions in a 30-day window have been
  uploaded.
- **No conversion values.** All four actions are configured "Don't use a
  value"; the uploader deliberately omits `conversion_value` from the
  payload. Adding a value would silently switch the action to value-based
  mode in Google's system.
- **No user_id linking.** The session-anonymous architecture is locked
  (see `docs/archive/GOOGLE_ADS_PLAN.md` §4). LTV-weighted bidding would require
  changing that and is out of scope. The hashed-email identifier is
  deliberately *not* an exception: `event` gains no `user_id`, no session→account
  join, and no plaintext address — only a one-way digest of the same value we
  hand to Google, written by the paths that already held the address.
- **No plaintext email, anywhere in this path.** Not in `event`, not in a log
  line, not in an alert email. Hashes are redacted to an 8-char prefix in logs
  (`redactHash`), mirroring how click ids are redacted.
