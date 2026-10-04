/**
 * The pending-language list after an edit to one translation input.
 *
 * Clearing an input deletes its translations.txt row, and when that was the
 * language's only row on this entity the language card (and the focused input)
 * used to unmount mid-edit (C3-14). Clearing to '' therefore pins the language
 * as pending so the card stays until the user clicks Remove.
 */
export function pendingAfterEdit(pending: readonly string[], language: string, value: string): string[] {
  if (value !== '' || pending.includes(language)) return pending as string[];
  return [...pending, language];
}
