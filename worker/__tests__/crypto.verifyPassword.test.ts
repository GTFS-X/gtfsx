// verifyPassword must fail closed (false, not throw) for stored hashes whose
// iteration count workerd cannot derive. Production workerd throws
// NotSupportedError above 100k, which turned login / change-email /
// change-password / delete-account into a 500 for such a credential.

import { describe, it, expect, vi } from 'vitest';
import { base64url, hashPassword, verifyPassword, PBKDF2_MAX_ITERATIONS } from '../util/crypto';

async function hashAt(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
}

describe('verifyPassword', () => {
  it('accepts a hash written by hashPassword', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith(`pbkdf2$${PBKDF2_MAX_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });

  it('returns false without deriving for iteration counts above the workerd cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A valid 600k hash of the right password, so the only reason to reject is
    // the iteration count. Miniflare accepts 600k; production workerd throws.
    const h = await hashAt('correct horse battery', 600_000);
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect(await verifyPassword('correct horse battery', h)).toBe(false);
    expect(derive).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    derive.mockRestore();
    warn.mockRestore();
  });
});
