import { ACS_YEAR } from '../../generated/acsVintage';
import type { TitleVIResult } from '../../services/titleVI';

/** Methodology footnote shown under the Title VI results (matches titleVI.ts). */
export const TITLE_VI_METHOD_NOTE =
  'Service metric: apportioned daily trips per block group (unique trip visits on one service ' +
  'day, weighted by circle-overlap fraction with each stop buffer: 0.25 mi, or 0.5 mi where the ' +
  'stop\'s peak headway is 15 minutes or less). Group values are unweighted means across block ' +
  `groups. Source: ACS ${ACS_YEAR} 5-Year B03002 (race) and C17002 (income-to-poverty).`;

/** "Based on Mon, Oct 5, 2026" style line for the service day behind the counts, or null. */
export function titleVIBasisLabel(basis: TitleVIResult['basis'] | undefined): string | null {
  if (!basis?.label) return null;
  return `Based on ${basis.label}`;
}
