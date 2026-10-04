// E2E S4: deleting a snapshot that a scheduled publish depends on is refused
// by the server; the error rendered in the panel behind the still-open
// "Delete snapshot?" dialog, whose overlay kept intercepting clicks. Restore
// had the same shape. Static contract: both confirms render their own error.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../SnapshotHistoryPanel.tsx', import.meta.url)), 'utf8');

function block(start: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n  };\n', i));
}

describe('snapshot confirm dialogs', () => {
  it('handleDelete and handleRestore report failures to the dialog, not the panel', () => {
    for (const name of ['const handleDelete = async', 'const handleRestore = async']) {
      const body = block(name);
      expect(body).toMatch(/setDialogError\(msg\)/);
      expect(body).not.toMatch(/\bsetError\(msg\)/);
    }
  });

  it('both ConfirmDialogs receive the dialog error and clear it on cancel', () => {
    for (const title of ['title="Delete snapshot?"', 'title="Restore this snapshot?"']) {
      const i = src.indexOf(title);
      const dialog = src.slice(i, src.indexOf('/>', i));
      expect(dialog).toMatch(/error=\{dialogError\}/);
      expect(dialog).toMatch(/onCancel=\{\(\) => \{[\s\S]*?setDialogError\(null\)/);
    }
  });
});
