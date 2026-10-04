// W2-07: unpublishing cancels a pending scheduled publish (server side), and
// the confirm and result copy say so.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notPublishedLabel, unpublishConfirmBody, unpublishDoneMessage } from '../unpublishCopy';
import { prettyAction } from '../../audit/auditFormat';

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

// E2E S6: after an unpublish the panel said "Not published yet.", and the
// Activity log showed the raw-ish "Project cancel scheduled publish".
describe('publication copy nits (E2E S6)', () => {
  it('drops "yet" once the feed has been published before', () => {
    expect(notPublishedLabel(true)).toBe('Not published.');
    expect(notPublishedLabel(false)).toBe('Not published yet.');
    const panel = readFileSync(fileURLToPath(new URL('../PublishPanel.tsx', import.meta.url)), 'utf8');
    expect(panel).toMatch(/notPublishedLabel\(publicationHistory\.length > 0\)/);
    expect(panel).not.toMatch(/>Not published yet\.</);
  });

  it('labels every project.* audit action the worker writes', () => {
    expect(prettyAction('project.cancel_scheduled_publish')).toBe('Cancelled scheduled publish');
    expect(prettyAction('project.schedule_publish')).toBe('Scheduled a publish');
    const worker = ['projects/routes.ts', 'projects/alerts.ts', 'publication/performPublish.ts']
      .map((f) => readFileSync(fileURLToPath(new URL(`../../../../worker/${f}`, import.meta.url)), 'utf8'))
      .join('\n');
    const actions = new Set([...worker.matchAll(/action: '(project\.[a-z_]+)'/g)].map((m) => m[1]));
    expect(actions.size).toBeGreaterThan(10);
    for (const a of actions) {
      // The fallback is "Project <words>"; a real label never starts that way.
      expect(prettyAction(a), a).not.toMatch(/^Project /);
    }
  });
});
