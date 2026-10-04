// trackBeacon session fallback + path cap (S2-25, S2-27), assistant stream
// `done` after `error` and link_docs allowlist (S2-26 client, C5-18), feedDiff
// schedule changes (S1-26).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffFeedState, type FeedState } from '../feedDiff';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('trackBeacon', () => {
  it('keeps one session id when sessionStorage throws, and caps the path at 512', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    vi.stubGlobal('window', { location: { pathname: '/x', search: '', hash: '' } });
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }));
    const { trackPageview } = await import('../trackBeacon');
    trackPageview('/a');
    trackPageview('/' + 'p'.repeat(600));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].sessionId).toBeTruthy();
    expect(bodies[1].sessionId).toBe(bodies[0].sessionId);
    expect(String(bodies[1].path)).toHaveLength(512);
  });
});

function sse(events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(new Blob([text]).stream(), { status: 200 });
}

async function runStream(events: [string, unknown][]) {
  vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
  const { streamAssistantChat } = await import('../assistantApi');
  const calls: string[] = [];
  const links: string[] = [];
  await new Promise<void>((resolve) => {
    streamAssistantChat({ messages: [], context: {} as never }, {
      onText: () => {},
      onOpenPanel: () => {},
      onLinkDocs: (d) => { links.push(d.url); },
      onFeatureRequest: () => {},
      onDone: () => { calls.push('done'); },
      onError: () => { calls.push('error'); },
    });
    setTimeout(resolve, 50);
  });
  return { calls, links };
}

describe('assistant stream', () => {
  it('ignores `done` after `error`', async () => {
    const { calls } = await runStream([['error', { message: 'x' }], ['done', { answerClass: 'supported' }]]);
    expect(calls).toEqual(['error']);
  });

  it('only accepts link_docs to our own docs/learn pages', async () => {
    const { links } = await runStream([
      ['tool', { name: 'link_docs', input: { url: 'https://evil.example/', title: 'x' } }],
      ['tool', { name: 'link_docs', input: { url: '/docs/agency-setup/', title: 'Agency' } }],
      ['tool', { name: 'link_docs', input: { url: '/learn/gtfs/#fares', title: 'Learn' } }],
      ['tool', { name: 'link_docs', input: { url: '/docs/../api/me', title: 'x' } }],
      ['done', {}],
    ]);
    expect(links).toEqual(['/docs/agency-setup/', '/learn/gtfs/#fares']);
  });
});

describe('feedDiff schedule changes', () => {
  const base = (dep: string): FeedState => ({
    routes: [], routeStops: [], stops: [], calendars: [], calendarDates: [], frequencies: [],
    trips: [{ trip_id: 't', route_id: 'R', service_id: 'WK', direction_id: 0 }],
    stopTimes: [
      { trip_id: 't', stop_id: 'a', stop_sequence: 1, arrival_time: dep, departure_time: dep },
      { trip_id: 't', stop_id: 'b', stop_sequence: 2, arrival_time: '09:00:00', departure_time: '09:00:00' },
    ],
  });

  it('a single shifted departure is not "identical"', () => {
    const d = diffFeedState(base('08:00:00'), base('08:15:00'));
    expect(d.scheduleChanged).toBe(true);
    expect(d.identical).toBe(false);
    expect(diffFeedState(base('08:00:00'), base('08:00:00')).identical).toBe(true);
  });
});
