// Deterministic "a competing request wins the single-use claim" harness.
//
// Parallel Promise.all requests only sometimes interleave between a handler's
// token check and its claim, so a test built on them can pass against code
// that has no atomic claim. This wraps the D1 binding so that, the first time
// the handler runs a statement matching `claimSql`, the same statement is
// executed once first, as a competing request would have done. A handler whose
// claim is a guarded single-use UPDATE then sees 0 changed rows and must
// refuse; one whose claim is unconditional proceeds, and the test goes red.

import worker from '../index';
import type { Env } from '../env';
import type { TestClient } from './_client';
import { env } from './_setup';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export function racingEnv(claimSql: RegExp): { env: Env; fired: () => boolean } {
  let armed = true;
  let didFire = false;
  const realDb = env.DB;
  const db = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!armed || !claimSql.test(sql)) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return new Proxy(bound, {
                get(t, p) {
                  if (p === 'run') {
                    return async () => {
                      if (armed) {
                        armed = false;
                        didFire = true;
                        await t.run(); // the competing request's claim lands first
                      }
                      return t.run();
                    };
                  }
                  const v = Reflect.get(t, p);
                  return typeof v === 'function' ? v.bind(t) : v;
                },
              });
            },
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB: db } as unknown as Env, fired: () => didFire };
}

/** Send a request through the Worker entrypoint with a substituted env. */
export async function fetchWithEnv(
  client: TestClient,
  withEnv: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'X-GB-Client': 'web' };
  if (client.cookie) headers.Cookie = client.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    }),
    withEnv,
    ctx,
  );
}
