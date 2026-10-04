// Forum fixes: ban enforcement on edits, soft-deleted authors, post-delete
// counters, thread-list pagination, image delete, fixed-window posting limits
// and the JPEG metadata strip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbAll, dbGet, dbRun, env, resetDb, seedUser, type SeededUser } from './_setup';
import { renderProfileSeo, renderThreadSeo } from '../forum/seo';
import { safeImageSrc } from '../forum/markdown';
import { readExifOrientation, stripJpegMetadata } from '../forum/uploads';

async function login(user: SeededUser): Promise<TestClient> {
  const c = makeClient();
  const res = await c.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return c;
}

async function member(email: string, name: string): Promise<{ user: SeededUser; c: TestClient }> {
  const user = await seedUser({ email });
  const c = await login(user);
  expect((await c.patch('/api/forum/profile/me', { displayName: name })).status).toBe(200);
  return { user, c };
}

async function categoryId(): Promise<string> {
  const cat = await dbGet<{ id: string }>(`SELECT id FROM forum_category WHERE locked = 0 LIMIT 1`);
  if (!cat) throw new Error('no unlocked forum category seeded');
  return cat.id;
}

async function newThread(c: TestClient, title = 'A thread title'): Promise<{ id: string }> {
  const res = await c.post('/api/forum/threads', { categoryId: await categoryId(), title, bodyMd: 'opening post' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { thread: { id: string } }).thread;
}

describe('forum hardening', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a banned author can no longer edit posts or mark answers', async () => {
    const staff = await seedUser({ email: 'fh-staff@example.com', staff: true });
    const staffC = await login(staff);
    const a = await member('fh-a@example.com', 'Author A');
    const b = await member('fh-b@example.com', 'Replier B');

    const thread = await newThread(a.c);
    const reply = await b.c.post(`/api/forum/threads/${thread.id}/posts`, { bodyMd: 'an answer' });
    expect(reply.status).toBe(201);
    const replyId = ((await reply.json()) as { post: { id: string } }).post.id;
    const op = await dbGet<{ id: string }>(
      `SELECT id FROM forum_post WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`, thread.id,
    );

    expect((await staffC.post(`/api/forum/profile/${a.user.id}/ban`, {})).status).toBe(200);

    const edit = await a.c.patch(`/api/forum/posts/${op!.id}`, { bodyMd: 'edited after ban' });
    expect(edit.status).toBe(422);
    const body = await dbGet<{ body_md: string }>(`SELECT body_md FROM forum_post WHERE id = ?`, op!.id);
    expect(body?.body_md).toBe('opening post');

    const solve = await a.c.patch(`/api/forum/threads/${thread.id}`, { solvedPostId: replyId });
    expect(solve.status).toBe(422);
    const t = await dbGet<{ solved_post_id: string | null }>(`SELECT solved_post_id FROM forum_thread WHERE id = ?`, thread.id);
    expect(t?.solved_post_id).toBeNull();
  });

  it('a soft-deleted author is shown as "Deleted user" with no Gravatar, and their profile page 404s', async () => {
    const a = await member('fh-gone@example.com', 'Bob');
    const thread = await newThread(a.c);
    await dbRun(`UPDATE user SET status = 'deleted_soft' WHERE id = ?`, a.user.id);

    const anon = makeClient();
    const res = await anon.json<{ thread: { author: { displayName: string; gravatarHash: string | null } } }>(
      await anon.get(`/api/forum/threads/${thread.id}`),
    );
    expect(res.thread.author.displayName).toBe('Deleted user');
    expect(res.thread.author.gravatarHash).toBeNull();

    expect(await renderProfileSeo(env, a.user.id)).toBeNull();
  });

  it('deleting a reply decrements post_count, restores last_post_at and lists the thread as unanswered again', async () => {
    const staff = await seedUser({ email: 'fh-staff2@example.com', staff: true });
    const staffC = await login(staff);
    const a = await member('fh-c@example.com', 'Author C');
    const b = await member('fh-d@example.com', 'Replier D');
    const thread = await newThread(a.c);
    const before = await dbGet<{ last_post_at: number }>(`SELECT last_post_at FROM forum_thread WHERE id = ?`, thread.id);

    const reply = await b.c.post(`/api/forum/threads/${thread.id}/posts`, { bodyMd: 'a reply' });
    const replyId = ((await reply.json()) as { post: { id: string } }).post.id;
    await dbRun(`UPDATE forum_post SET created_at = created_at + 5000 WHERE id = ?`, replyId);
    await dbRun(`UPDATE forum_thread SET last_post_at = last_post_at + 5000 WHERE id = ?`, thread.id);
    expect((await dbGet<{ post_count: number }>(`SELECT post_count FROM forum_thread WHERE id = ?`, thread.id))?.post_count).toBe(2);

    expect((await staffC.delete(`/api/forum/posts/${replyId}`)).status).toBe(204);
    const after = await dbGet<{ post_count: number; last_post_at: number }>(
      `SELECT post_count, last_post_at FROM forum_thread WHERE id = ?`, thread.id,
    );
    expect(after?.post_count).toBe(1);
    expect(after?.last_post_at).toBe(before?.last_post_at);

    const anon = makeClient();
    const list = await anon.json<{ threads: { id: string }[] }>(await anon.get('/api/forum/threads?sort=unanswered'));
    expect(list.threads.map((t) => t.id)).toContain(thread.id);

    const seo = await renderThreadSeo(env, thread.id);
    expect(seo?.body).toContain('0 replies');
  });

  it('paginates the thread list without gaps or repeats for every sort', async () => {
    const a = await member('fh-e@example.com', 'Author E');
    const cat = await categoryId();
    const base = 1_700_000_000_000;
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) {
      const id = ulid();
      ids.push(id);
      // Thread 0 is pinned and the oldest; created_at and last_post_at
      // disagree on order so the two sorts page differently.
      await dbRun(
        `INSERT INTO forum_thread (id, category_id, slug, title, author_user_id, created_at, last_post_at, post_count, view_count, pinned, locked, solved_post_id, deleted_at)
         VALUES (?, ?, 'thread', ?, ?, ?, ?, 1, 0, ?, 0, NULL, NULL)`,
        id, cat, `Thread number ${k}`, a.user.id, base + k * 1000, base + (5 - k) * 1000, k === 0 ? 1 : 0,
      );
    }
    const anon = makeClient();
    for (const sort of ['active', 'new']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const qs = new URLSearchParams({ category: cat, sort, limit: '2' });
        if (cursor) qs.set('cursor', cursor);
        const page: { threads: { id: string }[]; nextCursor: string | null } = await anon.json(
          await anon.get(`/api/forum/threads?${qs.toString()}`),
        );
        seen.push(...page.threads.map((t) => t.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen.length, sort).toBe(5);
      expect(new Set(seen), sort).toEqual(new Set(ids));
      expect(seen[0], sort).toBe(ids[0]); // pinned first
    }
  });

  it('an uploader or staff can delete a forum image; others cannot', async () => {
    const staff = await seedUser({ email: 'fh-staff3@example.com', staff: true });
    const staffC = await login(staff);
    const owner = await member('fh-img@example.com', 'Image Owner');
    const other = await member('fh-other@example.com', 'Someone Else');

    async function seedImage(): Promise<{ id: string; r2Key: string }> {
      const id = ulid();
      const r2Key = `images/${owner.user.id}/${id}.png`;
      await env.FORUM_IMAGES.put(r2Key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
      await dbRun(
        `INSERT INTO forum_image (id, user_id, r2_key, content_type, bytes, width, height, sha256, created_at)
         VALUES (?, ?, ?, 'image/png', 3, 1, 1, ?, ?)`,
        id, owner.user.id, r2Key, id, Date.now(),
      );
      return { id, r2Key };
    }

    const mine = await seedImage();
    const theirs = await seedImage();

    expect((await other.c.delete(`/api/forum/uploads/${mine.id}`)).status).toBe(403);
    expect((await owner.c.delete(`/api/forum/uploads/${mine.id}`)).status).toBe(204);
    expect((await staffC.delete(`/api/forum/uploads/${theirs.id}`)).status).toBe(204);
    expect((await owner.c.delete(`/api/forum/uploads/${ulid()}`)).status).toBe(404);

    for (const img of [mine, theirs]) {
      const res = await SELF.fetch(`http://img.test.local/_forum-images/${img.r2Key}`);
      expect(res.status).toBe(410);
      expect(await env.FORUM_IMAGES.get(img.r2Key)).toBeNull();
    }
    const live = await dbAll(`SELECT id FROM forum_image WHERE user_id = ? AND deleted_at IS NULL`, owner.user.id);
    expect(live).toHaveLength(0);
    const audit = await dbAll(`SELECT id FROM audit_event WHERE action = 'forum.image.delete'`);
    expect(audit).toHaveLength(2);
  });

  it('reply limits are fixed windows: replies spread across windows are not throttled', async () => {
    const a = await member('fh-rate@example.com', 'Rate Author');
    const thread = await newThread(a.c);
    const b = await member('fh-rate2@example.com', 'Rate Replier');

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Math.ceil(Date.now() / 600_000) * 600_000 + 1000;
    vi.setSystemTime(start);
    // Six replies 9 minutes apart. Under a refresh-on-write TTL the sixth hit
    // the 5-per-10-minutes cap; with fixed windows no bucket holds more than 2.
    for (let k = 0; k < 6; k++) {
      vi.setSystemTime(start + k * 9 * 60_000);
      const res = await b.c.post(`/api/forum/threads/${thread.id}/posts`, { bodyMd: `reply ${k}` });
      expect(res.status, `reply ${k}`).toBe(201);
    }
    // The faked clock reached the worker: the replies landed in several
    // 10-minute buckets.
    const keys = (await env.KV.list({ prefix: `rl:forum:post:short:${b.user.id}:` })).keys;
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── JPEG metadata strip ─────────────────────────────────────────────────────

function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}

/** Little-endian EXIF APP1 payload: IFD0 with Orientation + a GPS IFD pointer. */
function exifPayload(orientation: number): number[] {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x02, 0x00,                                     // 2 entries
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00,        // GPSInfo -> 38
    0x00, 0x00, 0x00, 0x00,                         // next IFD
    0x01, 0x00,                                     // GPS IFD: 1 entry
    0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x4e, 0x00, 0x00, 0x00,        // GPSLatitudeRef "N"
    0x00, 0x00, 0x00, 0x00,
  ];
  return [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
}

function syntheticJpeg(orientation: number): Uint8Array {
  const icc = [...'ICC_PROFILE'].map((ch) => ch.charCodeAt(0)).concat([0, 1, 1, 0xaa, 0xbb]);
  const adobe = [...'Adobe'].map((ch) => ch.charCodeAt(0)).concat([0, 100, 0, 0, 0, 0, 1]);
  const jfif = [...'JFIF'].map((ch) => ch.charCodeAt(0)).concat([0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, jfif),
    ...seg(0xe1, exifPayload(orientation)),
    ...seg(0xe2, icc),
    ...seg(0xee, adobe),
    ...seg(0xfe, [0x68, 0x69]),                         // COM "hi"
    ...seg(0xdb, [0x00, ...new Array(64).fill(1)]),     // DQT
    ...seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),     // SOF0 16x16
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),                  // SOS
    0x12, 0x34, 0x56,                                   // entropy data
    0xff, 0xd9,
  ]);
}

function markers(b: Uint8Array): number[] {
  const out: number[] = [];
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1];
    out.push(m);
    if (m === 0xda || m === 0xd9) break;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return out;
}

function app1Payload(b: Uint8Array): Uint8Array | null {
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1) return b.subarray(i + 4, i + 2 + len);
    if (m === 0xda || m === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}

describe('stripJpegMetadata', () => {
  it('keeps ICC (APP2), Adobe (APP14) and the orientation; drops GPS, JFIF and comments', () => {
    const out = stripJpegMetadata(syntheticJpeg(6));
    expect(markers(out)).toEqual([0xe1, 0xe2, 0xee, 0xdb, 0xc0, 0xda]);
    const app1 = app1Payload(out);
    expect(app1).not.toBeNull();
    expect(readExifOrientation(app1!)).toBe(6);
    // No GPSInfo tag (0x8825) in either byte order.
    const hex = Array.from(app1!).map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex).not.toContain('8825');
    expect(hex).not.toContain('2588');
    // Image data after SOS is untouched.
    expect(Array.from(out.slice(-5))).toEqual([0x12, 0x34, 0x56, 0xff, 0xd9]);
  });

  it('drops APP1 entirely when the orientation is already upright', () => {
    const out = stripJpegMetadata(syntheticJpeg(1));
    expect(markers(out)).toEqual([0xe2, 0xee, 0xdb, 0xc0, 0xda]);
  });

  it('reads orientation from the source EXIF', () => {
    const src = syntheticJpeg(8);
    expect(readExifOrientation(app1Payload(src)!)).toBe(8);
  });
});

describe('server-side safeImageSrc (SSR markdown)', () => {
  const hosts = ['img.gtfsx.com'];
  it('rejects relative paths that escape the forum-images prefix', () => {
    expect(safeImageSrc('/_forum-images/../api/me', hosts)).toBeNull();
    expect(safeImageSrc('/_forum-images/..%2fapi/me', hosts)).toBeNull();
    expect(safeImageSrc('/_forum-images/%2e%2e/api/me', hosts)).toBeNull();
    expect(safeImageSrc('/_forum-images/..\\api\\me', hosts)).toBeNull();
    expect(safeImageSrc('//evil.example/_forum-images/x.png', hosts)).toBeNull();
  });

  it('still allows relative and allow-listed absolute forum images', () => {
    expect(safeImageSrc('/_forum-images/images/u/x.png', hosts)).toBe('/_forum-images/images/u/x.png');
    expect(safeImageSrc('https://img.gtfsx.com/_forum-images/images/u/x.png', hosts)).toBe(
      'https://img.gtfsx.com/_forum-images/images/u/x.png',
    );
    expect(safeImageSrc('https://evil.example/_forum-images/x.png', hosts)).toBeNull();
  });
});
