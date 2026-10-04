// E2E A2: a refused org delete (409 active_subscription) rendered its message
// in the page-level banner, behind the still-open "Delete organization" modal,
// so the user saw nothing. Static contract: the error goes back to the dialog
// and the dialog renders it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../OrgSettingsPage.tsx', import.meta.url)), 'utf8');

/** Source from `name` up to the end of that block (`end` marks it). */
function body(name: string, end: RegExp): string {
  const start = src.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + name.length);
  const stop = rest.search(end);
  return rest.slice(0, stop === -1 ? undefined : stop);
}

describe('Delete organization dialog errors', () => {
  it('handleDeleteOrg returns the blocked copy instead of setting the page banner', () => {
    const handler = body('const handleDeleteOrg', /\n {2}\};\n/);
    expect(handler).toMatch(/return deleteBlockedMessage\(err, 'organization'/);
    expect(handler).not.toMatch(/setActionError\(deleteBlockedMessage/);
  });

  it('DeleteOrgDialog shows the returned error inside the modal', () => {
    const dialog = body('function DeleteOrgDialog', /\nfunction /);
    expect(dialog).toMatch(/onConfirm: \(\) => Promise<string \| null>/);
    expect(dialog).toMatch(/setError\(await onConfirm\(\)\)/);
    expect(dialog).toMatch(/\{error && \(\s*<p role="alert"/);
  });
});
