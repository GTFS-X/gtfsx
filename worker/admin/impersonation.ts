import type { Env } from '../env';

// Staff impersonation state.
//
// The staff identity to restore when impersonation ends is bound SERVER-SIDE
// to the impersonated session: a KV record keyed by that session's id, written
// only by the staff-gated POST /api/admin/users/:id/impersonate handler.
// POST /api/admin/end-impersonation reads it from the current session and never
// from anything the client sends. The gb_impersonator cookie remains only as a
// UI/flow hint ("an impersonation is in progress in this browser"); its value
// is not trusted as an identity.

export const IMPERSONATOR_COOKIE = 'gb_impersonator';

const KV_PREFIX = 'impersonation:session:';
// Matches the session absolute timeout; the session itself will usually
// expire or be revoked first.
const TTL_SEC = 90 * 24 * 60 * 60;

export interface ImpersonationBinding {
  staffUserId: string;
  targetUserId: string;
  startedAt: number;
}

export function impersonationKey(sessionId: string): string {
  return `${KV_PREFIX}${sessionId}`;
}

export async function writeImpersonationBinding(
  env: Env,
  sessionId: string,
  binding: ImpersonationBinding,
): Promise<void> {
  await env.KV.put(impersonationKey(sessionId), JSON.stringify(binding), { expirationTtl: TTL_SEC });
}

export async function readImpersonationBinding(env: Env, sessionId: string): Promise<ImpersonationBinding | null> {
  const raw = await env.KV.get(impersonationKey(sessionId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ImpersonationBinding>;
    if (typeof v.staffUserId !== 'string' || typeof v.targetUserId !== 'string') return null;
    return { staffUserId: v.staffUserId, targetUserId: v.targetUserId, startedAt: Number(v.startedAt) || 0 };
  } catch {
    return null;
  }
}

export async function clearImpersonationBinding(env: Env, sessionId: string): Promise<void> {
  await env.KV.delete(impersonationKey(sessionId));
}

export function impersonatorCookie(staffUserId: string): string {
  const maxAge = TTL_SEC;
  return `${IMPERSONATOR_COOKIE}=${staffUserId}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearImpersonatorCookie(): string {
  return `${IMPERSONATOR_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readImpersonatorCookie(req: Request): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === IMPERSONATOR_COOKIE && v) return v;
  }
  return null;
}
