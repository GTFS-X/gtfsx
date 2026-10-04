// C2-14: the header VariantSwitcher must not delete or discard variants
// without a confirm (neither action has an undo). Static contract: the
// destructive calls only appear inside a confirm dialog's onConfirm.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../VariantSwitcher.tsx', import.meta.url)), 'utf8');

describe('VariantSwitcher destructive actions', () => {
  it('never calls deleteVariant / discardVariants straight from a click handler', () => {
    expect(src).not.toMatch(/onClick=\{[^}]*\b(deleteVariant|discardVariants)\(/);
  });

  it('routes both through the shared confirm dialogs', () => {
    expect(src).toMatch(/<DeleteVariantConfirm[\s\S]*?onConfirm=\{\(\) => \{\s*deleteVariant\(/);
    expect(src).toMatch(/<DiscardVariantsConfirm[\s\S]*?onConfirm=\{\(\) => \{\s*discardVariants\(\)/);
  });
});
