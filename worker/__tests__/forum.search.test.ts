// GET /api/forum/search against real FTS5 data: the query must run (bm25 used
// in a valid context) and snippets must come back HTML-escaped, with only the
// <mark> highlighting added by the endpoint.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, dbGet, resetDb, seedUser, type SeededUser } from './_setup';
import { formatSearchSnippet, SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../forum/searchSnippet';

async function login(user: SeededUser): Promise<TestClient> {
  const c = makeClient();
  const res = await c.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return c;
}

interface SearchBody {
  results: { thread: { id: string; title: string }; snippet: string }[];
  nextCursor: string | null;
}

describe('forum search', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  async function poster(): Promise<TestClient> {
    const u = await seedUser({ email: 'poster-search@example.com' });
    const c = await login(u);
    expect((await c.patch('/api/forum/profile/me', { displayName: 'Poster One' })).status).toBe(200);
    return c;
  }

  async function categoryId(): Promise<string> {
    const cat = await dbGet<{ id: string }>(`SELECT id FROM forum_category WHERE locked = 0 LIMIT 1`);
    return cat!.id;
  }

  it('returns 200 with an escaped snippet when a post body contains HTML', async () => {
    const c = await poster();
    const cat = await categoryId();
    const payload = 'validator <img src=x onerror=alert(document.domain)> tips';
    const t = await c.post('/api/forum/threads', { categoryId: cat, title: 'Feed checker question', bodyMd: payload });
    expect([200, 201]).toContain(t.status);

    const res = await makeClient().get('/api/forum/search?q=validator', { noCookie: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(1);
    const snippet = body.results[0].snippet;
    expect(snippet).toContain('<mark>validator</mark>');
    expect(snippet).toContain('&lt;img src=x onerror=alert(document.domain)&gt;');
    expect(snippet).not.toContain('<img');
    // The only tags left are the highlight marks.
    expect(snippet.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
  });

  it('dedupes to one hit per thread and ranks a title match first', async () => {
    const c = await poster();
    const cat = await categoryId();
    const a = await c.json<{ thread: { id: string } }>(
      await c.post('/api/forum/threads', { categoryId: cat, title: 'Shapes export help', bodyMd: 'shapes shapes shapes in the body' }),
    );
    const b = await c.json<{ thread: { id: string } }>(
      await c.post('/api/forum/threads', { categoryId: cat, title: 'Calendar question', bodyMd: 'mentions shapes once' }),
    );
    const res = await makeClient().get('/api/forum/search?q=shapes', { noCookie: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    const ids = body.results.map((r) => r.thread.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([a.thread.id, b.thread.id]));
    expect(ids[0]).toBe(a.thread.id);
  });

  it('formatSearchSnippet escapes everything except the sentinel marks', () => {
    const raw = `a <b>&"'${SNIPPET_MARK_OPEN}hit${SNIPPET_MARK_CLOSE} </script>`;
    expect(formatSearchSnippet(raw)).toBe('a &lt;b&gt;&amp;&quot;&#39;<mark>hit</mark> &lt;/script&gt;');
    expect(formatSearchSnippet(null)).toBe('');
  });
});
