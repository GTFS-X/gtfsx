# GTFS Studio — Community Forum Requirements

High-level spec for an embedded community-support forum, comparable to the Caltopo community (Zendesk Gather) but built on the existing Cloudflare Worker + D1 + R2 + auth + email stack. `FM-*` anchors are reserved for cross-doc references.

Status: 🔲 not yet built. This document is the v1 spec for discussion.

---

## 1. Why this exists

Support for GTFS Studio is currently ad-hoc (email, the occasional GitHub issue). For a small-agency tool, three properties make a forum disproportionately valuable:

- **Long-tail self-serve.** Every answered question becomes a search hit for the next user who hits the same wall.
- **Peer-to-peer.** Transit-agency users often share problems with one another (GTFS quirks, fare-rule edge cases, validator errors) that we don't need to be in the middle of.
- **Roadmap signal.** Feature requests aggregate visibly instead of disappearing into our inbox.

Reference comparable: Caltopo's community at `help.caltopo.com/hc/en-us/community/topics` runs on Zendesk Guide/Gather ($55+/user/mo). We can ship a thinner version because users already sign in, we already have D1 + Resend wired up, and the embeds module already proves the SSR pattern.

---

## 2. Scope

**In (v1):**

- Single global community (one forum, all signed-in users)
- Admin-curated categories, seeded at launch (see §12)
- Threads with flat reply lists, ordered chronologically; the accepted-answer reply hoisted to the top of the list
- Markdown bodies with fenced code blocks
- Image attachments (screenshots of editor state, validator errors)
- **Post upvotes** — single integer score per post (Stack Overflow / Hacker News style, one vote per user per post, toggle to remove)
- Mark-as-solved on one reply per thread (by thread author or admin)
- **Basic profile management** — editable display name + Gravatar avatar (derived from email MD5)
- **Display-name gate** — on first visit to any `/community/*` route, a modal prompts the user to pick a display name. The modal is sticky (re-appears on the next visit if dismissed), and every server-side write endpoint refuses with a "set display name first" error until `users.display_name` is set. Reading is never gated.
- **Email notifications:**
  - Admin notified on every new thread creation
  - Thread author notified on every reply
  - Subscribers notified on replies in subscribed threads
  - One-click unsubscribe in every email
- Admin moderation: edit, soft-delete, lock, pin, move category, ban
- Public anonymous **read**; authenticated **post**

**Out (v1, revisit later):**

- Per-org private forums
- Direct messages
- Free-form tags beyond category
- Karma / badges / per-category reputation (the upvote count is visible on profile, but no thresholds or rewards)
- @-mentions
- Realtime updates (WebSocket / SSE)
- Polls, voting on threads themselves
- Avatar uploads (Gravatar only — falls back to the `identicon` default)

---

## 3. Information architecture

| Path | Surface |
|---|---|
| `/community` | Category index + recent activity |
| `/community/<category-slug>` | Thread list (tabs: Newest / Active / Unanswered) |
| `/community/<category-slug>/<thread-id>-<slug>` | Thread view: original post + replies |
| `/community/new` | Compose new thread (auth required) |
| `/community/u/<user-id>` | Public user page (display name, Gravatar, total upvotes received, their threads/posts) |
| `/community/profile` | Edit your own display name + email preferences (auth required) |
| `/community/notifications` | Per-user subscription + email-pref management |
| `/admin/community` | Moderation surface (admins only) |

Top-nav addition: "Community" link between Editor and Help, with a "New" badge for the first 30 days post-launch. Gated by `VITE_BACKEND_ENABLED` like the rest of the backend.

---

## 4. Data model (D1)

New migration `0008_forum.sql`:

- **forum_categories** — `id, slug, title, description, sort_order, locked, created_at`
- **forum_threads** — `id, category_id, slug, title, author_user_id, created_at, last_post_at, post_count, view_count, pinned, locked, solved_post_id (nullable), deleted_at (nullable)`
- **forum_posts** — `id, thread_id, author_user_id, body_md, created_at, edited_at (nullable), deleted_at (nullable)`
- **forum_attachments** — `id, post_id, r2_key, content_type, size_bytes, original_name` (uploaded to `gtfs-builder-feeds` bucket under `forum/<post_id>/<filename>` or a sibling bucket)
- **forum_subscriptions** — `user_id, thread_id, source ('author' | 'manual' | 'reply'), created_at` (PK composite)
- **forum_post_upvotes** — `post_id, user_id, created_at` (PK composite). Aggregate count maintained on `forum_posts.upvote_count` via app-level write or trigger.
- **forum_flags** — `id, post_id, reporter_user_id, reason, created_at, resolved_at (nullable), resolver_user_id (nullable)`
- **forum_mod_log** — `id, admin_user_id, action, target_type, target_id, note, created_at`
- **forum_user_state** — `user_id, banned_until (nullable)`

Display name + Gravatar live on the existing `users` table (extend with `display_name` if not already present). Gravatar URL is computed on demand as `https://www.gravatar.com/avatar/<md5(lowercase(trim(email)))>?d=identicon&s=<size>` — no storage, no API call. **Privacy note:** the MD5 of the user's email is included in image URLs served from the forum, which is a known property of Gravatar — flag this in the profile page and offer a "use a generic avatar" opt-out (`users.gravatar_opt_out` bool, falls back to `?d=identicon` with the user_id as the hash).

FTS5 virtual table **forum_search** over `(thread_title, post_body)` kept in sync via triggers.

---

## 5. Backend (Hono on Worker)

New module `worker/forum/` mounted under `/forum` in `worker/index.ts`:

- `index.ts` — router composition
- `categories.ts` — list/get; admin create/edit/delete
- `threads.ts` — list (filtered: category, status, search), create, get, lock, pin, move, soft-delete, mark-solved
- `posts.ts` — create, edit (author or admin, window-limited for non-admin), soft-delete, upvote toggle
- `profile.ts` — read public profile by user_id; authed PATCH `/forum/profile` for display name + gravatar opt-out + email prefs
- `subscriptions.ts` — subscribe/unsubscribe; auto-subscribe author on thread create and any user on reply (opt-out per pref)
- `attachments.ts` — presigned R2 upload, MIME allow-list (image/png, image/jpeg, image/gif, image/webp), 5 MB cap
- `notify.ts` — on new thread, enqueue admin notification; on new post, enqueue Resend emails to subscribers (reuses `worker/email/`)
- `search.ts` — FTS5 query wrapper
- `moderation.ts` — admin actions, writes to `forum_mod_log`

Public read endpoints are edge-cached with a short TTL; write endpoints invalidate by key prefix.

---

## 6. Frontend (React/TS in SPA)

New `src/components/community/` directory:

- `CategoryIndex.tsx`, `ThreadList.tsx`, `ThreadView.tsx`, `PostList.tsx`, `PostCard.tsx`
- `Composer.tsx` — textarea + markdown preview tab + drag/drop image upload that posts to the presigned R2 endpoint and inserts an `![](url)` token
- `UpvoteButton.tsx` — caret + count, optimistic toggle, disabled for the post's own author. **Anonymous click → "Sign in to vote" popover with a sign-in link**, not disabled-grey, so the call-to-action stays visible.
- `DisplayNameGate.tsx` — modal that intercepts the first visit to `/community/*` for any authed user without a display name. Single text input, submit calls `PATCH /forum/profile`, and on success the modal dismisses and the underlying page renders. Dismissable but re-appears every session; the server-side write block is the real enforcement.
- `Avatar.tsx` — renders Gravatar URL with size variants (24, 48, 96 px); used in PostCard, ThreadList row, ProfilePage
- `ProfilePage.tsx` (public, by user_id) and `ProfileEditor.tsx` (own profile: display name, Gravatar opt-out, email prefs)
- `SubscriptionToggle.tsx`, `MarkSolvedButton.tsx`
- `admin/ModerationQueue.tsx` — flagged posts + recent thread activity

Markdown rendering: `react-markdown` + `rehype-sanitize` + `rehype-highlight`. No raw HTML.

State: lightweight per-page fetch + cache via SWR-style hook; no Zustand slice needed (forum data doesn't intersect editor state).

---

## 7. Public-read SSR

Threads and category pages render server-side from the Worker (same pattern as `worker/embeds/`), producing indexable HTML with Open Graph + canonical-URL tags. The SPA hydrates over the SSR markup when the user clicks deeper. Sitemap entry per non-deleted thread; `X-Robots-Tag: index` on `/community/*`.

This is the main reason to host the forum ourselves rather than embed Giscus: the answers become organic search results pointing back at GTFS Studio.

---

## 8. Moderation

Admin role already exists (`BE-*` admin module). Available actions:

- Edit any post (post body marked "edited by moderator")
- Soft-delete post or thread (tombstone visible, body hidden)
- Lock thread (no new replies)
- Pin thread within a category (max 3 pins per category)
- Move thread between categories
- Set / unset accepted answer
- Ban user from forum for N days (writes `forum_user_state.banned_until`)

Every action writes a `forum_mod_log` row. The mod log is viewable at `/admin/community/log`.

---

## 9. Anti-spam / abuse

- Auth wall — no anonymous posting (signup already gated by Turnstile)
- Rate limits enforced in the Worker via D1 counters (or a Durable Object if contention emerges):
  - 5 posts per 10 minutes per user
  - 50 posts per day per user
  - 3 threads per day per user
- Markdown body cap: 64 KB
- Attachment cap: 5 MB per file, 4 files per post, image MIMEs only
- User flag → admin queue at `/admin/community/flags`

---

## 10. Email (Resend)

Reuses `worker/email/`. Templates:

- **New thread (admin alert)** — sent to every user with `is_admin=true` immediately on thread creation. No batching — admins want fast triage. Includes thread title, category, author, body excerpt, and a "Reply / Moderate" link. Admins can opt out of forum alerts in their own profile but it's **on by default**. If daily thread volume becomes noisy (rough threshold: >10/day sustained), revisit and add a 4-hour batching mode — defer until we have real volume.
- **Reply to your thread** — sent to thread author on each new reply (collapsed to one email per 10 min)
- **Reply on a subscribed thread** — sent to subscribers (auto-subscribed when they reply, or manually via the subscribe toggle)
- **Mark-as-solved** — sent to the post author when their reply is accepted as the answer
- **Weekly digest** (opt-in, Phase B) — top unanswered questions in categories you've posted in
- **Moderation notice** — when a moderator edits or deletes your post

All emails include a one-click unsubscribe link that toggles `forum_subscriptions` or a global `email_prefs.forum_*` flag on the user row. Subscription opt-outs are per-thread and per-category; the global kill switch is `email_prefs.forum_all`.

---

## 11. Capability snapshot

| Anchor | Capability | Status |
|---|---|---|
| FM-1 | Categories (admin-curated) | 🔲 |
| FM-2 | Threads (create, list, view) | 🔲 |
| FM-3 | Posts (markdown, edit, soft-delete) | 🔲 |
| FM-4 | Image attachments → R2 | 🔲 |
| FM-10 | Public read (anonymous, SSR) | 🔲 |
| FM-11 | Authenticated post + rate-limit | 🔲 |
| FM-20 | Post upvotes (single integer score, toggle) | 🔲 |
| FM-21 | Mark-as-solved | 🔲 |
| FM-22 | Basic profile: editable display name + Gravatar + opt-out | 🔲 |
| FM-23 | First-visit display-name gate (modal + server-side write block) | 🔲 |
| FM-30 | Subscriptions + reply notifications | 🔲 |
| FM-32 | Admin alert email on every new thread (default on) | 🔲 |
| FM-31 | Weekly digest (opt-in) | 🔲 |
| FM-40 | Admin moderation surface + audit log | 🔲 |
| FM-41 | User flagging queue | 🔲 |
| FM-42 | User bans | 🔲 |
| FM-50 | Search (D1 FTS5) | 🔲 |
| FM-60 | SEO: sitemap, Open Graph, canonical URLs | 🔲 |
| FM-70 | `/admin/community` dashboard | 🔲 |

---

## 12. Seed categories

Created by the same migration that introduces `forum_categories`, so the forum is never empty on first load. Initial set:

| Slug | Title | Description | Posting |
|---|---|---|---|
| `announcements` | 📣 Announcements | Release notes, scheduled maintenance, project news. | Admin-only |
| `getting-started` | 🧭 Getting Started | Setting up your first feed, importing an existing one, the editor basics. | All authed |
| `editor` | 🛠️ Editor & Workflow | Routes, stops, schedules, fares, shapes — questions about day-to-day editing. | All authed |
| `import-export` | 📦 Import, Export & Validation | GTFS validator errors, import edge cases, export quirks. | All authed |
| `embeds-publishing` | 🖼️ Embeds & Publishing | Mini-site, per-route / per-stop / system-map embeds, branding, distribution. | All authed |
| `feature-requests` | 💡 Feature Requests | What we should build next. | All authed |
| `bugs` | 🐞 Bug Reports | Something's wrong. Include feed + browser + steps. | All authed |
| `general` | 💬 General | Anything else GTFS-adjacent — show & tell, agency war stories, off-topic. | All authed |

`announcements` is a category-level lock (`forum_categories.locked = true`) — non-admin users can read and reply but cannot create new threads. The set is editable from `/admin/community` after launch; this list is just the seed.

---

## 13. Phasing (rough)

- **Phase A (~5 days + ½ day FAQ writing)** — schema + seeded categories, threads, posts (markdown, no attachments), public SSR read, authenticated post, **upvotes (with sign-in-to-vote popover for anonymous), profile (display name + Gravatar + opt-out), first-visit display-name gate, email notifications (admin-on-new-thread + reply-to-author + subscribed-thread)**, mark-as-solved. Pre-launch: write ~6–10 seed "How do I…" posts so the forum isn't empty on day one. Ship to staging.
- **Phase B (~2 days)** — image attachments via R2, weekly digest opt-in, mod-notice emails.
- **Phase C (~2 days)** — moderation surface, search (FTS5), sitemap / SEO, flag queue, ban flows.

Phase A is the minimum that delivers a working community-support forum. B+C can ship behind a feature flag if A goes out alone.

---

## 14. Open questions

None blocking — the v1 scope is settled. Items still worth confirming during implementation:

- **Ban duration UX.** Fixed durations (1 / 7 / 30 days) vs. free-form date picker. Lean toward a small dropdown.
- **Edit window.** How long after posting can a non-admin author edit their own post? Suggest 30 minutes for unsolved threads, indefinitely for the original post on their own thread.
- **Markdown subset.** Are tables and HTML disallowed via `rehype-sanitize`? Suggest: GFM tables yes, raw HTML no.
