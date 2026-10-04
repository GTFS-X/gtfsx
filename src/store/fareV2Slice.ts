import type { StateCreator } from 'zustand';
import type {
  FareArea,
  StopArea,
  FareNetwork,
  RouteNetwork,
  Timeframe,
  RiderCategory,
  FareMedia,
  FareProduct,
  FareLegRule,
  FareTransferRule,
} from '../types/gtfs';

/**
 * Outcome of a Fares v2 delete. `removed` is false when other rows still
 * reference the id; the arrays hold the indices of those rows (in
 * fareLegRules / fareTransferRules / fareProducts) so the editor can say what
 * is in the way. All empty when `removed` is true.
 */
export interface FareV2RemovalResult {
  removed: boolean;
  fareLegRules: number[];
  fareTransferRules: number[];
  fareProducts: number[];
}

function removedResult(): FareV2RemovalResult {
  return { removed: true, fareLegRules: [], fareTransferRules: [], fareProducts: [] };
}

function indicesWhere<T>(rows: readonly T[], pred: (row: T) => boolean): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => { if (pred(r)) out.push(i); });
  return out;
}

/** A refusal when any of the reference lists is non-empty, else null. */
function refusal(refs: Partial<Omit<FareV2RemovalResult, 'removed'>>): FareV2RemovalResult | null {
  const r: FareV2RemovalResult = {
    removed: false,
    fareLegRules: refs.fareLegRules ?? [],
    fareTransferRules: refs.fareTransferRules ?? [],
    fareProducts: refs.fareProducts ?? [],
  };
  return r.fareLegRules.length + r.fareTransferRules.length + r.fareProducts.length > 0 ? r : null;
}

/** fare_products.txt's primary key is (fare_product_id, rider_category_id,
 *  fare_media_id): one product id may have a row per rider category / medium. */
function sameProductRow(a: FareProduct, b: FareProduct): boolean {
  return a.fare_product_id === b.fare_product_id
    && (a.rider_category_id ?? '') === (b.rider_category_id ?? '')
    && (a.fare_media_id ?? '') === (b.fare_media_id ?? '');
}

/**
 * GTFS-Fares v2 store. Holds parsed entities so they round-trip through
 * import/export, plus authoring CRUD for the editors that have shipped.
 *
 * Authoring status (see docs/REQUIREMENTS.md §1.6.2):
 *   • areas.txt + stop_areas.txt — Areas editor (shipped).
 *   • rider_categories, fare_media, fare_products, fare_leg_rules,
 *     fare_transfer_rules, networks/route_networks, timeframes — CRUD editors
 *     (shipped). The cross-file references (rider category / fare media on a
 *     product; networks/areas/timeframes/products on leg rules; leg groups /
 *     products on transfer rules) are kept consistent here: renames cascade,
 *     and a delete is REFUSED while another row still references the id (it
 *     returns a FareV2RemovalResult naming the blocking rows). Clearing the
 *     reference instead would silently broaden a rule: a leg rule with no
 *     network matches every network, a product with no rider category applies
 *     to every rider, a transfer rule with no product is a free transfer.
 *
 * Row-keyed vs index-keyed CRUD: files with a unique id (areas, rider
 * categories, media, products, networks) are addressed by that id. Files with
 * no single-column key (timeframes, leg rules, transfer rules) are addressed by
 * array index, matching how their editors render an ordered list.
 */
export interface FareV2Slice {
  fareAreas: FareArea[];
  stopAreas: StopArea[];
  fareNetworks: FareNetwork[];
  routeNetworks: RouteNetwork[];
  timeframes: Timeframe[];
  riderCategories: RiderCategory[];
  fareMedia: FareMedia[];
  fareProducts: FareProduct[];
  fareLegRules: FareLegRule[];
  fareTransferRules: FareTransferRule[];

  setFareAreas: (rows: FareArea[]) => void;
  setStopAreas: (rows: StopArea[]) => void;
  setFareNetworks: (rows: FareNetwork[]) => void;
  setRouteNetworks: (rows: RouteNetwork[]) => void;
  setTimeframes: (rows: Timeframe[]) => void;
  setRiderCategories: (rows: RiderCategory[]) => void;
  setFareMedia: (rows: FareMedia[]) => void;
  setFareProducts: (rows: FareProduct[]) => void;
  setFareLegRules: (rows: FareLegRule[]) => void;
  setFareTransferRules: (rows: FareTransferRule[]) => void;

  // ── Areas authoring (areas.txt + stop_areas.txt) ──────────────────────────
  /** Create an area. No-op if area_id already exists (area_id is unique). */
  addFareArea: (area: FareArea) => void;
  /** Update area_name (and any other fields) for an existing area. */
  updateFareArea: (areaId: string, updates: Partial<Omit<FareArea, 'area_id'>>) => void;
  /** Rename an area_id, cascading the change to its stop_areas mappings and
   *  to leg rules' from/to_area_id.
   *  No-op on collision (newId already in use) — merging areas is never silent. */
  renameFareAreaId: (oldId: string, newId: string) => void;
  /** Delete an area and every stop_areas mapping that references it.
   *  Refused while a leg rule uses it as from/to area. */
  removeFareArea: (areaId: string) => FareV2RemovalResult;
  /** Assign a stop to an area. No-op if the (area_id, stop_id) pair exists. */
  addStopToArea: (areaId: string, stopId: string) => void;
  /** Bulk-assign many stops to an area in one update, deduping against the
   *  mappings already present (and against duplicate ids within the batch).
   *  Used by the "select stops by polygon" lasso so a many-stop selection is a
   *  single store write. No-op for stops already in the area. */
  addStopsToArea: (areaId: string, stopIds: string[]) => void;
  /** Remove a stop from an area. */
  removeStopFromArea: (areaId: string, stopId: string) => void;

  // ── Rider categories (rider_categories.txt) ───────────────────────────────
  /** Create a rider category. No-op on duplicate rider_category_id. */
  addRiderCategory: (cat: RiderCategory) => void;
  updateRiderCategory: (id: string, updates: Partial<Omit<RiderCategory, 'rider_category_id'>>) => void;
  /** Rename a rider_category_id, cascading to fare_products that reference it. */
  renameRiderCategoryId: (oldId: string, newId: string) => void;
  /** Delete a category. Refused while a fare product is priced for it. */
  removeRiderCategory: (id: string) => FareV2RemovalResult;

  // ── Fare media (fare_media.txt) ───────────────────────────────────────────
  addFareMediaItem: (media: FareMedia) => void;
  updateFareMediaItem: (id: string, updates: Partial<Omit<FareMedia, 'fare_media_id'>>) => void;
  /** Rename a fare_media_id, cascading to fare_products that reference it. */
  renameFareMediaId: (oldId: string, newId: string) => void;
  /** Delete a medium. Refused while a fare product is priced for it. */
  removeFareMediaItem: (id: string) => FareV2RemovalResult;

  // ── Fare products (fare_products.txt) ─────────────────────────────────────
  /** Add a product row. No-op when a row with the same primary key
   *  (fare_product_id, rider_category_id, fare_media_id) exists; one product
   *  id may carry a row per rider category / fare medium. */
  addFareProduct: (product: FareProduct) => void;
  /** Update the FIRST row with this id. Prefer updateFareProductAt when a
   *  product id has several rows. */
  updateFareProduct: (id: string, updates: Partial<Omit<FareProduct, 'fare_product_id'>>) => void;
  /** Update one product row by its index in fareProducts. */
  updateFareProductAt: (index: number, updates: Partial<Omit<FareProduct, 'fare_product_id'>>) => void;
  /** Rename a fare_product_id on EVERY row that carries it, cascading to
   *  leg/transfer rules. No-op when newId is already another product's id. */
  renameFareProductId: (oldId: string, newId: string) => void;
  /** Delete every row of a product. Refused while a leg rule or transfer rule
   *  is priced with it. */
  removeFareProduct: (id: string) => FareV2RemovalResult;
  /** Delete one product row by index. When it is the id's last row, the same
   *  reference check as removeFareProduct applies. */
  removeFareProductAt: (index: number) => FareV2RemovalResult;

  // ── Networks (networks.txt + route_networks.txt) ──────────────────────────
  addFareNetwork: (net: FareNetwork) => void;
  updateFareNetwork: (id: string, updates: Partial<Omit<FareNetwork, 'network_id'>>) => void;
  /** Rename a network_id, cascading to route_networks + leg rules. */
  renameFareNetworkId: (oldId: string, newId: string) => void;
  /** Delete a network and its route_networks mappings. Refused while a leg
   *  rule is scoped to it. */
  removeFareNetwork: (id: string) => FareV2RemovalResult;
  /** Assign a route to a network. No-op if the (network_id, route_id) pair exists.
   *  A route may belong to at most one network — assigning moves it. */
  addRouteToNetwork: (networkId: string, routeId: string) => void;
  /** Remove a route from a network. */
  removeRouteFromNetwork: (networkId: string, routeId: string) => void;

  // ── Timeframes (timeframes.txt) ───────────────────────────────────────────
  /** Append a timeframe row. Rows are addressed by index since a single
   *  timeframe_group_id spans many (start, end, service) windows. */
  addTimeframe: (tf: Timeframe) => void;
  updateTimeframe: (index: number, updates: Partial<Timeframe>) => void;
  /** Delete one timeframe row. Refused when it is the last row of its
   *  timeframe_group_id and a leg rule references that group. */
  removeTimeframe: (index: number) => FareV2RemovalResult;
  /** Rename a timeframe_group_id across every row, cascading to leg rules. */
  renameTimeframeGroupId: (oldId: string, newId: string) => void;

  // ── Fare leg rules (fare_leg_rules.txt) ───────────────────────────────────
  addFareLegRule: (rule: FareLegRule) => void;
  updateFareLegRule: (index: number, updates: Partial<FareLegRule>) => void;
  /** Delete one leg rule. Refused when it is the last rule of its
   *  leg_group_id and a transfer rule references that group. */
  removeFareLegRule: (index: number) => FareV2RemovalResult;

  // ── Fare transfer rules (fare_transfer_rules.txt) ─────────────────────────
  addFareTransferRule: (rule: FareTransferRule) => void;
  updateFareTransferRule: (index: number, updates: Partial<FareTransferRule>) => void;
  removeFareTransferRule: (index: number) => void;
}

/** Leg and transfer rules priced with product `id`. */
function productRefusal(
  st: Pick<FareV2Slice, 'fareLegRules' | 'fareTransferRules'>,
  id: string,
): FareV2RemovalResult | null {
  return refusal({
    fareLegRules: indicesWhere(st.fareLegRules, (r) => r.fare_product_id === id),
    fareTransferRules: indicesWhere(st.fareTransferRules, (r) => r.fare_product_id === id),
  });
}

export const createFareV2Slice: StateCreator<FareV2Slice, [['zustand/immer', never]], [], FareV2Slice> = (set, get) => ({
  fareAreas: [],
  stopAreas: [],
  fareNetworks: [],
  routeNetworks: [],
  timeframes: [],
  riderCategories: [],
  fareMedia: [],
  fareProducts: [],
  fareLegRules: [],
  fareTransferRules: [],

  setFareAreas: (rows) => set((state) => { state.fareAreas = rows; }),
  setStopAreas: (rows) => set((state) => { state.stopAreas = rows; }),
  setFareNetworks: (rows) => set((state) => { state.fareNetworks = rows; }),
  setRouteNetworks: (rows) => set((state) => { state.routeNetworks = rows; }),
  setTimeframes: (rows) => set((state) => { state.timeframes = rows; }),
  setRiderCategories: (rows) => set((state) => { state.riderCategories = rows; }),
  setFareMedia: (rows) => set((state) => { state.fareMedia = rows; }),
  setFareProducts: (rows) => set((state) => { state.fareProducts = rows; }),
  setFareLegRules: (rows) => set((state) => { state.fareLegRules = rows; }),
  setFareTransferRules: (rows) => set((state) => { state.fareTransferRules = rows; }),

  addFareArea: (area) => set((state) => {
    if (state.fareAreas.some((a) => a.area_id === area.area_id)) return;
    state.fareAreas.push(area);
  }),
  updateFareArea: (areaId, updates) => set((state) => {
    const area = state.fareAreas.find((a) => a.area_id === areaId);
    if (area) Object.assign(area, updates);
  }),
  renameFareAreaId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.fareAreas.some((a) => a.area_id === newId)) return;
    const area = state.fareAreas.find((a) => a.area_id === oldId);
    if (!area) return;
    area.area_id = newId;
    for (const sa of state.stopAreas) {
      if (sa.area_id === oldId) sa.area_id = newId;
    }
    for (const r of state.fareLegRules) {
      if (r.from_area_id === oldId) r.from_area_id = newId;
      if (r.to_area_id === oldId) r.to_area_id = newId;
    }
  }),
  removeFareArea: (areaId) => {
    const blocked = refusal({
      fareLegRules: indicesWhere(get().fareLegRules, (r) => r.from_area_id === areaId || r.to_area_id === areaId),
    });
    if (blocked) return blocked;
    set((state) => {
      state.fareAreas = state.fareAreas.filter((a) => a.area_id !== areaId);
      state.stopAreas = state.stopAreas.filter((sa) => sa.area_id !== areaId);
    });
    return removedResult();
  },
  addStopToArea: (areaId, stopId) => set((state) => {
    if (state.stopAreas.some((sa) => sa.area_id === areaId && sa.stop_id === stopId)) return;
    state.stopAreas.push({ area_id: areaId, stop_id: stopId });
  }),
  addStopsToArea: (areaId, stopIds) => set((state) => {
    const existing = new Set(
      state.stopAreas.filter((sa) => sa.area_id === areaId).map((sa) => sa.stop_id),
    );
    for (const stopId of stopIds) {
      if (existing.has(stopId)) continue;
      existing.add(stopId); // also dedup repeats within the incoming batch
      state.stopAreas.push({ area_id: areaId, stop_id: stopId });
    }
  }),
  removeStopFromArea: (areaId, stopId) => set((state) => {
    state.stopAreas = state.stopAreas.filter(
      (sa) => !(sa.area_id === areaId && sa.stop_id === stopId),
    );
  }),

  // ── Rider categories ──────────────────────────────────────────────────────
  addRiderCategory: (cat) => set((state) => {
    if (state.riderCategories.some((c) => c.rider_category_id === cat.rider_category_id)) return;
    state.riderCategories.push(cat);
  }),
  updateRiderCategory: (id, updates) => set((state) => {
    const c = state.riderCategories.find((x) => x.rider_category_id === id);
    if (c) Object.assign(c, updates);
  }),
  renameRiderCategoryId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.riderCategories.some((c) => c.rider_category_id === newId)) return;
    const c = state.riderCategories.find((x) => x.rider_category_id === oldId);
    if (!c) return;
    c.rider_category_id = newId;
    for (const p of state.fareProducts) {
      if (p.rider_category_id === oldId) p.rider_category_id = newId;
    }
  }),
  removeRiderCategory: (id) => {
    const blocked = refusal({
      fareProducts: indicesWhere(get().fareProducts, (p) => p.rider_category_id === id),
    });
    if (blocked) return blocked;
    set((state) => {
      state.riderCategories = state.riderCategories.filter((c) => c.rider_category_id !== id);
    });
    return removedResult();
  },

  // ── Fare media ────────────────────────────────────────────────────────────
  addFareMediaItem: (media) => set((state) => {
    if (state.fareMedia.some((m) => m.fare_media_id === media.fare_media_id)) return;
    state.fareMedia.push(media);
  }),
  updateFareMediaItem: (id, updates) => set((state) => {
    const m = state.fareMedia.find((x) => x.fare_media_id === id);
    if (m) Object.assign(m, updates);
  }),
  renameFareMediaId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.fareMedia.some((m) => m.fare_media_id === newId)) return;
    const m = state.fareMedia.find((x) => x.fare_media_id === oldId);
    if (!m) return;
    m.fare_media_id = newId;
    for (const p of state.fareProducts) {
      if (p.fare_media_id === oldId) p.fare_media_id = newId;
    }
  }),
  removeFareMediaItem: (id) => {
    const blocked = refusal({
      fareProducts: indicesWhere(get().fareProducts, (p) => p.fare_media_id === id),
    });
    if (blocked) return blocked;
    set((state) => {
      state.fareMedia = state.fareMedia.filter((m) => m.fare_media_id !== id);
    });
    return removedResult();
  },

  // ── Fare products ─────────────────────────────────────────────────────────
  addFareProduct: (product) => set((state) => {
    if (state.fareProducts.some((p) => sameProductRow(p, product))) return;
    state.fareProducts.push(product);
  }),
  updateFareProduct: (id, updates) => set((state) => {
    const p = state.fareProducts.find((x) => x.fare_product_id === id);
    if (p) Object.assign(p, updates);
  }),
  updateFareProductAt: (index, updates) => set((state) => {
    const p = state.fareProducts[index];
    if (p) Object.assign(p, updates);
  }),
  renameFareProductId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.fareProducts.some((p) => p.fare_product_id === newId)) return;
    if (!state.fareProducts.some((p) => p.fare_product_id === oldId)) return;
    for (const p of state.fareProducts) {
      if (p.fare_product_id === oldId) p.fare_product_id = newId;
    }
    for (const r of state.fareLegRules) {
      if (r.fare_product_id === oldId) r.fare_product_id = newId;
    }
    for (const r of state.fareTransferRules) {
      if (r.fare_product_id === oldId) r.fare_product_id = newId;
    }
  }),
  removeFareProduct: (id) => {
    const blocked = productRefusal(get(), id);
    if (blocked) return blocked;
    set((state) => {
      state.fareProducts = state.fareProducts.filter((p) => p.fare_product_id !== id);
    });
    return removedResult();
  },
  removeFareProductAt: (index) => {
    const products = get().fareProducts;
    const row = products[index];
    if (!row) return removedResult();
    const lastRow = !products.some((p, i) => i !== index && p.fare_product_id === row.fare_product_id);
    if (lastRow) {
      const blocked = productRefusal(get(), row.fare_product_id);
      if (blocked) return blocked;
    }
    set((state) => { state.fareProducts.splice(index, 1); });
    return removedResult();
  },

  // ── Networks + route_networks ─────────────────────────────────────────────
  addFareNetwork: (net) => set((state) => {
    if (state.fareNetworks.some((n) => n.network_id === net.network_id)) return;
    state.fareNetworks.push(net);
  }),
  updateFareNetwork: (id, updates) => set((state) => {
    const n = state.fareNetworks.find((x) => x.network_id === id);
    if (n) Object.assign(n, updates);
  }),
  renameFareNetworkId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.fareNetworks.some((n) => n.network_id === newId)) return;
    const n = state.fareNetworks.find((x) => x.network_id === oldId);
    if (!n) return;
    n.network_id = newId;
    for (const rn of state.routeNetworks) {
      if (rn.network_id === oldId) rn.network_id = newId;
    }
    for (const r of state.fareLegRules) {
      if (r.network_id === oldId) r.network_id = newId;
    }
  }),
  removeFareNetwork: (id) => {
    const blocked = refusal({
      fareLegRules: indicesWhere(get().fareLegRules, (r) => r.network_id === id),
    });
    if (blocked) return blocked;
    set((state) => {
      state.fareNetworks = state.fareNetworks.filter((n) => n.network_id !== id);
      state.routeNetworks = state.routeNetworks.filter((rn) => rn.network_id !== id);
    });
    return removedResult();
  },
  addRouteToNetwork: (networkId, routeId) => set((state) => {
    if (state.routeNetworks.some((rn) => rn.network_id === networkId && rn.route_id === routeId)) return;
    // A route belongs to at most one network — reassigning moves it.
    state.routeNetworks = state.routeNetworks.filter((rn) => rn.route_id !== routeId);
    state.routeNetworks.push({ network_id: networkId, route_id: routeId });
  }),
  removeRouteFromNetwork: (networkId, routeId) => set((state) => {
    state.routeNetworks = state.routeNetworks.filter(
      (rn) => !(rn.network_id === networkId && rn.route_id === routeId),
    );
  }),

  // ── Timeframes ────────────────────────────────────────────────────────────
  addTimeframe: (tf) => set((state) => {
    state.timeframes.push(tf);
  }),
  updateTimeframe: (index, updates) => set((state) => {
    const tf = state.timeframes[index];
    if (tf) Object.assign(tf, updates);
  }),
  removeTimeframe: (index) => {
    const { timeframes, fareLegRules } = get();
    const row = timeframes[index];
    if (!row) return removedResult();
    const group = row.timeframe_group_id;
    const lastRow = !timeframes.some((t, i) => i !== index && t.timeframe_group_id === group);
    if (lastRow) {
      const blocked = refusal({
        fareLegRules: indicesWhere(
          fareLegRules,
          (r) => r.from_timeframe_group_id === group || r.to_timeframe_group_id === group,
        ),
      });
      if (blocked) return blocked;
    }
    set((state) => { state.timeframes.splice(index, 1); });
    return removedResult();
  },
  renameTimeframeGroupId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    for (const tf of state.timeframes) {
      if (tf.timeframe_group_id === oldId) tf.timeframe_group_id = newId;
    }
    for (const r of state.fareLegRules) {
      if (r.from_timeframe_group_id === oldId) r.from_timeframe_group_id = newId;
      if (r.to_timeframe_group_id === oldId) r.to_timeframe_group_id = newId;
    }
  }),

  // ── Fare leg rules ────────────────────────────────────────────────────────
  addFareLegRule: (rule) => set((state) => {
    state.fareLegRules.push(rule);
  }),
  updateFareLegRule: (index, updates) => set((state) => {
    const r = state.fareLegRules[index];
    if (r) Object.assign(r, updates);
  }),
  removeFareLegRule: (index) => {
    const { fareLegRules, fareTransferRules } = get();
    const rule = fareLegRules[index];
    if (!rule) return removedResult();
    const group = rule.leg_group_id;
    const lastOfGroup = group !== undefined && group !== ''
      && !fareLegRules.some((r, i) => i !== index && r.leg_group_id === group);
    if (lastOfGroup) {
      const blocked = refusal({
        fareTransferRules: indicesWhere(
          fareTransferRules,
          (t) => t.from_leg_group_id === group || t.to_leg_group_id === group,
        ),
      });
      if (blocked) return blocked;
    }
    set((state) => { state.fareLegRules.splice(index, 1); });
    return removedResult();
  },

  // ── Fare transfer rules ───────────────────────────────────────────────────
  addFareTransferRule: (rule) => set((state) => {
    state.fareTransferRules.push(rule);
  }),
  updateFareTransferRule: (index, updates) => set((state) => {
    const r = state.fareTransferRules[index];
    if (r) Object.assign(r, updates);
  }),
  removeFareTransferRule: (index) => set((state) => {
    if (index >= 0 && index < state.fareTransferRules.length) state.fareTransferRules.splice(index, 1);
  }),
});
