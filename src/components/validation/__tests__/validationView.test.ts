// ValidationPanel / ExportDialog helpers:
// - C3-11: the validation memo is keyed on every slice the validator reads
//   (translations and feedInfo used to be missing, so their messages went stale).
// - C3-12: errors are not dismissible; a dismissed code hides warnings only.
// - C3-13: the fix Undo toast is retired by the next feed-data edit.
// - C3-25: an unrelated store change (project name, UI state) doesn't change
//   the memo key, so ExportDialog no longer re-validates on every keystroke.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallow } from 'zustand/shallow';
import { useStore } from '../../../store';
import { resetHistory } from '../../../store/history';
import { VALIDATION_INPUT_KEYS } from '../../../services/validation';
import type { ValidationMessage } from '../../../types/ui';
import {
  selectValidationInputs, isDismissible, partitionDismissed, onNextFeedDataChange,
} from '../validationView';

const s = () => useStore.getState();
const m = (id: string, severity: 'error' | 'warning', code?: string): ValidationMessage =>
  ({ id, severity, message: `${severity} ${id}`, code }) as ValidationMessage;

beforeEach(() => {
  s().setTranslations([]);
  s().setStops([]);
  resetHistory();
});

describe('selectValidationInputs (C3-11, C3-25)', () => {
  it('covers translations and feedInfo, and every validator input key', () => {
    const inputs = selectValidationInputs(s());
    expect(inputs).toHaveLength(VALIDATION_INPUT_KEYS.length);
    expect(inputs).toContain(s().translations);
    expect(VALIDATION_INPUT_KEYS).toContain('feedInfo');
    expect(VALIDATION_INPUT_KEYS).toContain('translations');
  });

  it('changes when a translation row is edited, so stale messages re-run', () => {
    const before = selectValidationInputs(s());
    s().setTranslations([
      { table_name: 'stops', field_name: 'stop_name', language: 'not a tag!', translation: 'x', record_id: 'S1' },
    ]);
    expect(shallow(before, selectValidationInputs(s()))).toBe(false);
  });

  it('is unchanged by a project rename or UI state change (no re-validation)', () => {
    const before = selectValidationInputs(s());
    s().setProjectName('Something else');
    s().setSidebarSection('stops');
    expect(shallow(before, selectValidationInputs(s()))).toBe(true);
  });
});

describe('dismissal (C3-12)', () => {
  it('only warnings with a code are dismissible', () => {
    expect(isDismissible(m('1', 'warning', 'c'))).toBe(true);
    expect(isDismissible(m('2', 'error', 'c'))).toBe(false);
    expect(isDismissible(m('3', 'warning'))).toBe(false);
  });

  it('a dismissed code hides its warnings but leaves its errors visible', () => {
    const msgs = [m('e', 'error', 'flex'), m('w', 'warning', 'flex'), m('o', 'warning', 'other')];
    const { visible, dismissed } = partitionDismissed(msgs, ['flex']);
    expect(visible.map((x) => x.id)).toEqual(['e', 'o']);
    expect(dismissed.map((x) => x.id)).toEqual(['w']);
  });
});

describe('onNextFeedDataChange (C3-13)', () => {
  it('fires once on the next feed-data edit, not on UI changes', () => {
    const cb = vi.fn();
    const unsub = onNextFeedDataChange(useStore, cb);
    s().setSidebarSection('routes');
    s().setProjectName('Renamed');
    expect(cb).not.toHaveBeenCalled();
    s().setTranslations([
      { table_name: 'stops', field_name: 'stop_name', language: 'es', translation: 'Hola', record_id: 'S1' },
    ]);
    expect(cb).toHaveBeenCalledTimes(1);
    s().setTranslations([]);
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('does nothing after unsubscribe', () => {
    const cb = vi.fn();
    onNextFeedDataChange(useStore, cb)();
    s().setTranslations([
      { table_name: 'stops', field_name: 'stop_name', language: 'fr', translation: 'Bonjour', record_id: 'S1' },
    ]);
    expect(cb).not.toHaveBeenCalled();
  });
});
