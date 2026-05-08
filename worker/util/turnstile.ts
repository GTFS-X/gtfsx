import type { Env } from '../env';
import { validationFailed } from './errors';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  challenge_ts?: string;
}

/**
 * Verify a Cloudflare Turnstile response token against the siteverify
 * endpoint. Throws `validation_failed` on missing/invalid tokens.
 *
 * If `TURNSTILE_SECRET_KEY` is unset (typical for `wrangler dev --local`
 * without the secret), verification is skipped with a console warning.
 * The matching frontend gate (`turnstileSiteKey === ''`) means no token is
 * sent anyway — the two are flipped together in deployed environments.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined | null,
  ip: string | null,
): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification');
    return;
  }
  if (!token) {
    throw validationFailed('Captcha required');
  }

  const params = new URLSearchParams();
  params.append('secret', env.TURNSTILE_SECRET_KEY);
  params.append('response', token);
  if (ip) params.append('remoteip', ip);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[turnstile] siteverify network error', err);
    throw validationFailed('Captcha verification failed');
  }
  if (!res.ok) {
    throw validationFailed('Captcha verification failed');
  }
  const data = (await res.json()) as SiteverifyResponse;
  if (!data.success) {
    console.warn('[turnstile] siteverify rejected', data['error-codes']);
    throw validationFailed('Captcha verification failed');
  }
}
