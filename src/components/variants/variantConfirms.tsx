import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * The two destructive variant confirms, shared by the RightRail VariantsPanel
 * and the header VariantSwitcher so neither can delete or discard without
 * asking (C2-14). Neither action has an undo.
 */
export function DeleteVariantConfirm({
  name,
  isActive,
  onCancel,
  onConfirm,
}: {
  name: string;
  isActive: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      danger
      title={`Delete "${name}"?`}
      body={
        <>
          This removes the variant and its edits from the set.
          {isActive && ' You’ll be switched back to the baseline.'}
          {' '}Nothing is written until you Save.
        </>
      }
      confirmLabel="Delete variant"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function DiscardVariantsConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      danger
      title="Discard all variants?"
      body="This drops the whole variant set and returns the editor to the baseline feed. Nothing is written until you Save."
      confirmLabel="Discard variants"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
