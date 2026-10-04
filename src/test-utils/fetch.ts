// A fetch stub for rendered component tests: the API layer (projectsApi,
// orgsApi, billingApi…) runs for real and only the network boundary is faked.
// Gzip request bodies (working-state PUTs) are decoded so tests can assert on
// the JSON that would have reached the server.
import { vi } from 'vitest';

// jsdom's Blob has no stream(), which projectsApi's gzipString needs; use
// Node's. (Reached through process.getBuiltinModule because the app tsconfig
// does not load @types/node.)
const nodeProcess = (globalThis as unknown as {
  process: { getBuiltinModule: (id: string) => { Blob: typeof Blob } };
}).process;
const NodeBlob = nodeProcess.getBuiltinModule('node:buffer').Blob;

export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response> | undefined;

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function decodeBody(init: RequestInit | undefined): Promise<unknown> {
  const raw = init?.body;
  if (raw == null) return undefined;
  const headers = new Headers(init?.headers);
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (raw instanceof FormData) return raw;
  const bytes = new Uint8Array(await new Response(raw as BodyInit).arrayBuffer());
  let text: string;
  if (headers.get('content-encoding') === 'gzip') {
    const stream = new NodeBlob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  try { return JSON.parse(text); } catch { return text; }
}

/** Replace global fetch (and Blob, see above). Unhandled requests get `{}`
 *  with 200 so incidental page loads (lists, counts) don't throw; tests assert
 *  on `calls`. Undo with `vi.unstubAllGlobals()`. */
export function mockFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path, body: await decodeBody(init) };
    calls.push(call);
    return (await handler(call)) ?? json({});
  });
  return calls;
}
