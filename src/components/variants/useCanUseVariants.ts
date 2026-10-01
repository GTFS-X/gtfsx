import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/**
 * Whether the current user can use feed variants (A2), per the planConfig
 * 'variants' key. Since the Sep 2026 free-planning change that key is granted
 * to every plan (free + anonymous included), so this is effectively always
 * true; the hook stays so a future re-gate is a config change. Kept in its own
 * module so VariantSwitcher stays a components-only file (react-refresh).
 */
export function useCanUseVariants(): boolean {
  const plan = useEditorPlan();
  return planHasFeature(plan, 'variants');
}
