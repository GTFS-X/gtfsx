import type { UnitSystem } from '../utils/units';

/**
 * Reconciling the browser's display-units choice with the signed-in account's
 * (issue #76). Pure so the rules are testable without a store or network.
 *
 * Rules, in order:
 *  1. The account value is unknown (`undefined`: the response didn't carry it)
 *     → do nothing.
 *  2. The user changed the toggle in this tab before the account value arrived
 *     → their fresh choice wins: push it if it differs from the account.
 *  3. The account has a value → use it locally (and cache it in this browser).
 *  4. The account has none, but this browser holds an explicit choice → push
 *     that choice up once.
 *  5. Neither has one → nothing; the default (imperial) applies.
 */
export interface UnitSyncDecision {
  /** Set the local preference to this (without pushing it back). */
  apply: UnitSystem | null;
  /** PATCH the account with this. */
  push: UnitSystem | null;
}

export function decideUnitSync(input: {
  server: UnitSystem | null | undefined;
  stored: UnitSystem | null;
  current: UnitSystem;
  changedLocally: boolean;
}): UnitSyncDecision {
  const { server, stored, current, changedLocally } = input;
  if (server === undefined) return { apply: null, push: null };
  if (changedLocally) return { apply: null, push: server === current ? null : current };
  if (server !== null) return { apply: server === current && stored === server ? null : server, push: null };
  if (stored !== null) return { apply: null, push: stored };
  return { apply: null, push: null };
}
