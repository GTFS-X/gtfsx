import type { Env } from '../env';
import type { ThreadRow, PostRow } from './types';

// Forum email senders. Each is best-effort: failures are logged but never
// thrown back into the request handler — the user shouldn't see "your post
// went through but the email didn't" as an error on the write that succeeded.
//
// Volume controls:
//   - Per-thread author reply notifications are collapsed to one per 10 min
//     via a KV "cooldown" key so multi-reply storms don't blast the OP.
//   - Admin alerts on new-thread are NOT batched — admins want fast triage.
//     Add batching once daily thread volume sustains >10/day.

const APP_ORIGIN_FALLBACK = 'https://www.gtfsstudio.net';

function appOrigin(env: Env): string {
  return env.APP_ORIGIN || APP_ORIGIN_FALLBACK;
}

function threadUrl(env: Env, thread: ThreadRow): string {
  return `${appOrigin(env)}/community/${thread.category_id}/${thread.id}-${thread.slug}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function excerpt(body: string, max = 240): string {
  const stripped = body.replace(/\s+/g, ' ').trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max).trimEnd() + '…';
}

async function sendOne(env: Env, to: string, subject: string, html: string, text: string): Promise<void> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.AUTH_EMAIL_FROM,
        to,
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('forum email send failed', res.status, body.slice(0, 200));
    }
  } catch (err) {
    console.error('forum email send threw', err);
  }
}

// ─── Templates ──────────────────────────────────────────────────────────────

export async function notifyAdminsNewThread(
  env: Env,
  thread: ThreadRow,
  authorDisplayName: string,
  bodyMd: string,
): Promise<void> {
  // Pull all staff users with admin alerts on. Staff is set on the user
  // table; opt-out lives on forum_user_state.email_pref_admin_alerts.
  const admins = await env.DB.prepare(
    `SELECT u.id, u.email
       FROM user u
       LEFT JOIN forum_user_state f ON f.user_id = u.id
      WHERE u.staff = 1
        AND u.status = 'active'
        AND COALESCE(f.email_pref_admin_alerts, 1) = 1
        AND COALESCE(f.email_pref_all_off, 0) = 0`,
  ).all<{ id: string; email: string }>();

  if (!admins.results || admins.results.length === 0) return;

  const url = threadUrl(env, thread);
  const subject = `[Community] New thread: ${thread.title}`;
  const html = `
    <p><strong>${escapeHtml(authorDisplayName)}</strong> posted a new thread in <em>${escapeHtml(thread.category_id)}</em>:</p>
    <h2 style="font-size: 16px; margin: 16px 0 8px;"><a href="${url}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(thread.title)}</a></h2>
    <blockquote style="margin: 0 0 16px; padding: 8px 12px; border-left: 3px solid #e8d8c0; color: #555; font-size: 13px;">
      ${escapeHtml(excerpt(bodyMd, 400))}
    </blockquote>
    <p><a href="${url}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Reply or moderate →</a></p>
  `;
  const text = `New community thread: ${thread.title}\n\nBy ${authorDisplayName} in ${thread.category_id}\n\n${excerpt(bodyMd, 400)}\n\n${url}`;

  for (const admin of admins.results) {
    const unsub = `${appOrigin(env)}/community/profile?unsubscribe=admin_alerts`;
    await sendOne(env, admin.email, subject, wrapWithUnsub(env, html, unsub), text);
  }
}

export async function notifyThreadAuthorOfReply(
  env: Env,
  thread: ThreadRow,
  reply: PostRow,
  replyAuthorDisplayName: string,
): Promise<void> {
  if (reply.author_user_id === thread.author_user_id) return;

  // Collapse: one email per (thread, recipient) per 10 minutes.
  const cooldownKey = `forum:reply-cooldown:${thread.id}:${thread.author_user_id}`;
  const existing = await env.KV.get(cooldownKey);
  if (existing) return;

  const authorRow = await env.DB.prepare(
    `SELECT u.email, COALESCE(f.email_pref_replies, 1) as pref, COALESCE(f.email_pref_all_off, 0) as off
       FROM user u
       LEFT JOIN forum_user_state f ON f.user_id = u.id
      WHERE u.id = ? AND u.status = 'active'`,
  )
    .bind(thread.author_user_id)
    .first<{ email: string; pref: number; off: number }>();

  if (!authorRow || authorRow.off === 1 || authorRow.pref === 0) return;

  await env.KV.put(cooldownKey, String(Date.now()), { expirationTtl: 600 });

  const url = threadUrl(env, thread) + '#post-' + reply.id;
  const subject = `Re: ${thread.title}`;
  const html = `
    <p><strong>${escapeHtml(replyAuthorDisplayName)}</strong> replied to your thread:</p>
    <h2 style="font-size: 16px; margin: 16px 0 8px;"><a href="${url}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(thread.title)}</a></h2>
    <blockquote style="margin: 0 0 16px; padding: 8px 12px; border-left: 3px solid #e8d8c0; color: #555; font-size: 13px;">
      ${escapeHtml(excerpt(reply.body_md, 400))}
    </blockquote>
    <p><a href="${url}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">View reply →</a></p>
  `;
  const text = `${replyAuthorDisplayName} replied to "${thread.title}":\n\n${excerpt(reply.body_md, 400)}\n\n${url}`;

  const unsub = `${appOrigin(env)}/community/profile?unsubscribe=replies`;
  await sendOne(env, authorRow.email, subject, wrapWithUnsub(env, html, unsub), text);
}

export async function notifySubscribersOfReply(
  env: Env,
  thread: ThreadRow,
  reply: PostRow,
  replyAuthorDisplayName: string,
): Promise<void> {
  // Subscribers minus the reply author (and we skip the OP — they get the
  // dedicated author-reply email above).
  const subs = await env.DB.prepare(
    `SELECT u.id, u.email
       FROM forum_subscription s
       JOIN user u ON u.id = s.user_id
       LEFT JOIN forum_user_state f ON f.user_id = u.id
      WHERE s.thread_id = ?
        AND u.status = 'active'
        AND u.id != ?
        AND u.id != ?
        AND COALESCE(f.email_pref_subscribed, 1) = 1
        AND COALESCE(f.email_pref_all_off, 0) = 0`,
  )
    .bind(thread.id, reply.author_user_id, thread.author_user_id)
    .all<{ id: string; email: string }>();

  if (!subs.results || subs.results.length === 0) return;

  const url = threadUrl(env, thread) + '#post-' + reply.id;
  const subject = `Re: ${thread.title}`;
  const html = `
    <p><strong>${escapeHtml(replyAuthorDisplayName)}</strong> replied to a thread you're following:</p>
    <h2 style="font-size: 16px; margin: 16px 0 8px;"><a href="${url}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(thread.title)}</a></h2>
    <blockquote style="margin: 0 0 16px; padding: 8px 12px; border-left: 3px solid #e8d8c0; color: #555; font-size: 13px;">
      ${escapeHtml(excerpt(reply.body_md, 400))}
    </blockquote>
    <p><a href="${url}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">View reply →</a></p>
  `;
  const text = `${replyAuthorDisplayName} replied to "${thread.title}":\n\n${excerpt(reply.body_md, 400)}\n\n${url}`;

  for (const sub of subs.results) {
    const unsub = `${appOrigin(env)}/community/profile?unsubscribe=subscribed&thread=${thread.id}`;
    await sendOne(env, sub.email, subject, wrapWithUnsub(env, html, unsub), text);
  }
}

export async function notifyAuthorMarkedSolved(
  env: Env,
  thread: ThreadRow,
  post: PostRow,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT u.email, u.display_name, COALESCE(f.email_pref_mark_solved, 1) as pref, COALESCE(f.email_pref_all_off, 0) as off
       FROM user u
       LEFT JOIN forum_user_state f ON f.user_id = u.id
      WHERE u.id = ? AND u.status = 'active'`,
  )
    .bind(post.author_user_id)
    .first<{ email: string; display_name: string; pref: number; off: number }>();
  if (!row || row.off === 1 || row.pref === 0) return;

  const url = threadUrl(env, thread) + '#post-' + post.id;
  const subject = `Your reply was marked as the answer`;
  const html = `
    <p>Nice — your reply was marked as the accepted answer on:</p>
    <h2 style="font-size: 16px; margin: 16px 0 8px;"><a href="${url}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(thread.title)}</a></h2>
    <p><a href="${url}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">View thread →</a></p>
  `;
  const text = `Your reply to "${thread.title}" was marked as the answer.\n\n${url}`;

  const unsub = `${appOrigin(env)}/community/profile?unsubscribe=mark_solved`;
  await sendOne(env, row.email, subject, wrapWithUnsub(env, html, unsub), text);
}

function wrapWithUnsub(env: Env, bodyHtml: string, unsubUrl: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 32px auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
  <h1 style="font-size: 18px; margin: 0 0 16px; color: #2a1a0e;">GTFS Studio Community</h1>
  ${bodyHtml}
  <hr style="border: 0; border-top: 1px solid #eee; margin: 32px 0 16px;" />
  <p style="color: #888; font-size: 12px;">
    <a href="${unsubUrl}" style="color: #888;">Manage community emails</a> · Sent by ${escapeHtml(appOrigin(env))}
  </p>
</body></html>`;
}
