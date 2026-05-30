// PII/secret redaction for error logs (NF-72). See worker/util/redact.ts.

import { describe, it, expect } from 'vitest';
import { redactPii, errorDetail } from '../util/redact';

describe('redactPii', () => {
  it('redacts email addresses', () => {
    expect(redactPii('login failed for alice@example.com')).toBe('login failed for [email]');
  });

  it('redacts Authorization header values', () => {
    expect(redactPii('Authorization: Bearer abc123.def-456_ghi')).toBe('Authorization: Bearer [redacted]');
    expect(redactPii('Basic dXNlcjpwYXNz')).toBe('Basic [redacted]');
  });

  it('redacts Stripe-style secret keys', () => {
    expect(redactPii('used sk_live_51HxYzAbCdEf and whsec_aBcD1234')).toBe(
      'used sk_live_[redacted] and whsec_[redacted]',
    );
  });

  it('redacts the session cookie value', () => {
    expect(redactPii('Cookie: gb_session=abcDEF123.xyz; other=1')).toBe(
      'Cookie: gb_session=[redacted]; other=1',
    );
  });

  it('redacts sensitive query-string params (token/password/key/code)', () => {
    expect(redactPii('GET /auth/verify?token=SECRETvalue123&foo=bar')).toBe(
      'GET /auth/verify?token=[redacted]&foo=bar',
    );
    expect(redactPii('?refresh_token=rt_abc&password=hunter2')).toBe(
      '?refresh_token=[redacted]&password=[redacted]',
    );
  });

  it('leaves benign stack-trace content intact', () => {
    const stack = 'Error: boom\n    at handler (worker/index.ts:110:11)\n    at async fetch';
    expect(redactPii(stack)).toBe(stack);
  });

  it('redacts multiple occurrences and types together', () => {
    const out = redactPii('user bob@test.io with Bearer tok_abc hit ?code=xyz');
    expect(out).toContain('[email]');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('?code=[redacted]');
    expect(out).not.toContain('bob@test.io');
  });
});

describe('errorDetail', () => {
  it('returns a redacted stack for an Error', () => {
    const err = new Error('failed for carol@example.com');
    const out = errorDetail(err);
    expect(out).toContain('[email]');
    expect(out).not.toContain('carol@example.com');
  });

  it('handles non-Error thrown values', () => {
    expect(errorDetail('plain string with dave@example.com')).toBe('plain string with [email]');
    expect(errorDetail({ msg: 'x' })).toBe('{"msg":"x"}');
    expect(errorDetail(null)).toBe('null');
  });
});
