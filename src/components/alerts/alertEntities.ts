import type { InformedEntity } from '../../services/alertsApi';

export type EntityKind = 'route' | 'stop' | 'agency';

// Key off which field is PRESENT, not truthy — an unselected Route row
// (`{ route_id: '' }`) must stay "route", not collapse to "whole feed".
export function entityKind(e: InformedEntity): EntityKind {
  if ('stop_id' in e) return 'stop';
  if ('route_id' in e) return 'route';
  return 'agency';
}

/**
 * Resolve the editor's "Whole feed" rows into entities a GTFS-RT consumer can
 * match. The UI only offers "Whole feed" (never a specific agency), so every
 * agency-kind row means the whole feed:
 *
 * - one `{agency_id}` per agency, so in a joint feed agency 2's riders are
 *   informed too (C3-24: it used to emit only the first agency);
 * - when any agency has a blank agency_id (valid in a single-agency feed), an
 *   agency selector can't reach it, so fall back to every route_id.
 *
 * Several whole-feed rows expand once (an alert re-opened for editing comes
 * back with one whole-feed row per agency).
 */
export function expandEntities(
  entities: InformedEntity[],
  routes: readonly { route_id: string }[],
  agencies: readonly { agency_id?: string }[],
): InformedEntity[] {
  const agencyIds = agencies.map((a) => a.agency_id ?? '');
  const everyAgencyHasId = agencyIds.length > 0 && agencyIds.every((id) => id !== '');
  const wholeFeed: InformedEntity[] = everyAgencyHasId
    ? agencyIds.map((agency_id) => ({ agency_id }))
    : routes.map((r) => ({ route_id: r.route_id }));

  const out: InformedEntity[] = [];
  let wholeFeedAdded = false;
  for (const e of entities) {
    if (entityKind(e) !== 'agency') out.push(e);
    else if (!wholeFeedAdded) {
      out.push(...wholeFeed);
      wholeFeedAdded = true;
    }
  }
  return out;
}

export function entityComplete(e: InformedEntity, hasRoutes: boolean): boolean {
  const kind = entityKind(e);
  if (kind === 'stop') return !!e.stop_id;
  if (kind === 'route') return !!e.route_id;
  return !!e.agency_id || hasRoutes; // whole feed: agency_id or expandable to routes
}
