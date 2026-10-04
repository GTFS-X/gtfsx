// W2-07: unpublishing cancels a pending scheduled publish (server side), and
// the confirm and result copy say so.
import { describe, expect, it } from 'vitest';
import { unpublishConfirmBody, unpublishDoneMessage } from '../unpublishCopy';

describe('unpublish copy (W2-07)', () => {
  it('names the pending scheduled publish that will be cancelled', () => {
    const body = unpublishConfirmBody('Oct 12, 2026, 6:00 AM');
    expect(body).toMatch(/404/);
    expect(body).toMatch(/scheduled publish for Oct 12, 2026, 6:00 AM will be cancelled/);
  });

  it('says nothing about a schedule when none is pending', () => {
    expect(unpublishConfirmBody(null)).not.toMatch(/schedul/i);
  });

  it('result banner mentions the cancelled schedule only when there was one', () => {
    expect(unpublishDoneMessage(true)).toMatch(/scheduled publish was cancelled/);
    expect(unpublishDoneMessage(false)).not.toMatch(/schedul/i);
  });
});
