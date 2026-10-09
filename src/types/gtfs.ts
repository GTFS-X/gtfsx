export interface Agency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_lang?: string;
  agency_phone?: string;
  agency_fare_url?: string;
  agency_email?: string;
  /**
   * External identifier for this agency — in the US, its FTA National Transit
   * Database (NTD) ID. Written to agency.txt as a custom `external_id` column
   * whenever any agency in the feed has one (see gtfsExport), and read back
   * per-row on import, so it round-trips.
   *
   * Free-form STRING, deliberately not format-checked: NTD IDs carry
   * significant leading zeros ("01234") and the field may also hold a non-NTD
   * identifier. Never Number()-coerce it. Empty is stored as undefined so no
   * empty column is ever emitted.
   */
  external_id?: string;
}

export interface Calendar {
  service_id: string;
  monday: 0 | 1;
  tuesday: 0 | 1;
  wednesday: 0 | 1;
  thursday: 0 | 1;
  friday: 0 | 1;
  saturday: 0 | 1;
  sunday: 0 | 1;
  start_date: string; // YYYYMMDD
  end_date: string;   // YYYYMMDD
  _description?: string; // UI-only
}

export interface CalendarDate {
  service_id: string;
  date: string;           // YYYYMMDD
  exception_type: 1 | 2;  // 1=added, 2=removed
}

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc?: string;
  route_type: number;
  route_url?: string;
  route_color: string;      // 6-char hex without #
  route_text_color: string;  // 6-char hex without #
  /**
   * GTFS-Flex: default for continuous boarding along the route.
   * 0=allowed, 1=none (default), 2=phone agency, 3=coordinate with driver.
   * Overridden per-stop_time where continuous_pickup / continuous_drop_off
   * is set on the stop_times row.
   */
  continuous_pickup?: 0 | 1 | 2 | 3;
  continuous_drop_off?: 0 | 1 | 2 | 3;
  _cost_per_revenue_hour?: number;  // UI-only
  _avg_speed_mph?: number;          // UI-only — Generate-service average speed (run-time estimates)
  _vehicles_required?: number;      // UI-only
  _direction_0_name?: string;       // UI-only, default "Outbound"
  _direction_1_name?: string;       // UI-only, default "Inbound"
}

export interface ShapePoint {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
  shape_dist_traveled: number;
}

export interface Shape {
  shape_id: string;
  points: ShapePoint[];
  _name?: string; // UI-only label for the shape (GTFS shapes.txt has no name); stripped on export
  // UI-only: the route a freshly DRAWN shape belongs to before it has any trip
  // or route_stop, so it doesn't vanish from the Route Shapes panel / map (which
  // otherwise derive a shape's route from its trips). Editor association only —
  // shapes.txt has no route link; stripped on export.
  _route_id?: string;
}

export interface Stop {
  stop_id: string;
  stop_code?: string;
  stop_name: string;
  stop_desc?: string;
  stop_lat: number;
  stop_lon: number;
  zone_id?: string;
  stop_url?: string;
  location_type: number;
  parent_station?: string;
  stop_timezone?: string;
  wheelchair_boarding: number;
  level_id?: string; // FK to levels.txt — which level (floor) this stop is on
}

export interface Trip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign?: string;
  trip_short_name?: string;
  direction_id: 0 | 1;
  block_id?: string;
  shape_id?: string;
  wheelchair_accessible?: number;
}

export interface StopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: number;
  stop_headsign?: string;
  pickup_type?: number;
  drop_off_type?: number;
  shape_dist_traveled?: number;
  timepoint?: 0 | 1;
  /**
   * GTFS-Flex: continuous boarding between this stop and the next.
   * 0=allowed, 1=none, 2=phone agency, 3=coordinate with driver.
   * Overrides the route-level default when set.
   */
  continuous_pickup?: 0 | 1 | 2 | 3;
  continuous_drop_off?: 0 | 1 | 2 | 3;
}

export interface FeedInfo {
  feed_publisher_name: string;
  feed_publisher_url: string;
  feed_lang: string;
  default_lang?: string;
  feed_start_date?: string;
  feed_end_date?: string;
  feed_version?: string;
  feed_contact_email?: string;
  feed_contact_url?: string;
}

export interface FareAttribute {
  fare_id: string;
  price: string;
  currency_type: string;
  payment_method: 0 | 1;       // 0=on board, 1=before boarding
  transfers: 0 | 1 | 2 | '';   // ''=unlimited
  transfer_duration?: number;   // seconds
  agency_id?: string;
}

export interface FareRule {
  fare_id: string;
  route_id?: string;
  origin_id?: string;
  destination_id?: string;
  contains_id?: string;
}

export interface RouteStop {
  route_id: string;
  stop_id: string;
  direction_id: 0 | 1;
  stop_sequence: number;
  _snapped: boolean;
  // The shape this stop belongs to. Stops are per-shape (a route can have
  // several shapes in one direction — branches, short-turns), so the editor
  // keys a route's stop list by shape. Optional for back-compat: legacy/
  // imported route_stops without it fall back to direction_id filtering.
  shape_id?: string;
  // Synthetic per-instance handle. A pattern may legally list the same
  // stop_id more than once (e.g. a loop whose first and last stop are
  // identical), so stop_id can't identify a route_stop. `_uid` does. Like
  // `_snapped`, the underscore prefix keeps it out of exported GTFS
  // (stripUIFields drops `_`-prefixed keys; route_stops aren't exported
  // anyway). Assigned by addRouteStop / setRouteStops; stable for the
  // lifetime of the instance.
  _uid?: string;
}

export interface Transfer {
  /**
   * Stop ids. Required for transfer_type 1–3 (and normally set for 0); may be
   * empty for in-seat transfers (4/5), which are keyed by trip ids. Kept as
   * `string` ('' when absent) so stop-keyed consumers stay simple; the
   * exporter writes '' as a blank cell.
   */
  from_stop_id: string;
  to_stop_id: string;
  /** Optional route qualifiers (transfer applies only between these routes). */
  from_route_id?: string;
  to_route_id?: string;
  /** Optional trip qualifiers; required for in-seat transfers (4/5). */
  from_trip_id?: string;
  to_trip_id?: string;
  /**
   * 0 = recommended transfer (default), 1 = timed transfer (vehicle waits),
   * 2 = min_transfer_time required, 3 = transfer not possible,
   * 4 = in-seat transfer (stay on board), 5 = in-seat transfer not allowed.
   */
  transfer_type: 0 | 1 | 2 | 3 | 4 | 5;
  /** Seconds required to make the transfer. Required when transfer_type=2. */
  min_transfer_time?: number;
}

/**
 * frequencies.txt — headway-based (frequency) service for a trip. A trip with
 * frequencies rows runs every `headway_secs` between start_time and end_time
 * rather than on the explicit times in stop_times (which then act as a single
 * reference run). A trip may have multiple non-overlapping windows.
 */
export interface Frequency {
  trip_id: string;
  start_time: string;   // HH:MM:SS, may exceed 24:00:00
  end_time: string;     // HH:MM:SS, may exceed 24:00:00
  headway_secs: number; // positive integer
  /** 0 = frequency-based (default), 1 = schedule-based exact times. */
  exact_times?: 0 | 1;
}

/** levels.txt — a level (floor) within a station, referenced by stops + pathways. */
export interface Level {
  level_id: string;
  level_index: number;  // float; 0 = ground, negative = below grade
  level_name?: string;
}

/**
 * pathways.txt — a directed edge between two stop/node points inside a station
 * (walkway, stairs, elevator, …). Used by trip planners for in-station routing.
 */
export interface Pathway {
  pathway_id: string;
  from_stop_id: string;
  to_stop_id: string;
  /** 1 walkway, 2 stairs, 3 moving sidewalk, 4 escalator, 5 elevator, 6 fare gate, 7 exit gate. */
  pathway_mode: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  is_bidirectional: 0 | 1;
  length?: number;          // meters
  traversal_time?: number;  // seconds
  stair_count?: number;     // signed integer
  max_slope?: number;
  min_width?: number;       // meters
  signposted_as?: string;
  reversed_signposted_as?: string;
}

/* ─────────────────────────────────────────────────────────────────────────
 * GTFS-Fares v2 — Phase 1: round-trip only.
 *
 * v2 lives in a parallel set of files alongside v1's fare_attributes.txt /
 * fare_rules.txt; consumers prefer v2 when present and fall back to v1.
 * The editor preserves these on import → export but doesn't yet expose UI
 * for authoring them; see Section 1.6 of docs/REQUIREMENTS.md for the
 * Phase 2/3 roadmap (editor UI and validation rules).
 * ───────────────────────────────────────────────────────────────────────── */

/** areas.txt — a fare area, used by fare_leg_rules and stop_areas. */
export interface FareArea {
  area_id: string;
  area_name?: string;
}

/** stop_areas.txt — assigns a stop to one or more fare areas. */
export interface StopArea {
  area_id: string;
  stop_id: string;
}

/** networks.txt — a named grouping of routes for fare purposes. */
export interface FareNetwork {
  network_id: string;
  network_name?: string;
}

/** route_networks.txt — assigns a route to a fare network. */
export interface RouteNetwork {
  network_id: string;
  route_id: string;
}

/** timeframes.txt — a time window used by leg rules (peak/off-peak). */
export interface Timeframe {
  timeframe_group_id: string;
  start_time?: string; // HH:MM:SS
  end_time?: string;   // HH:MM:SS
  service_id: string;
}

/** rider_categories.txt — first-class rider type (adult, senior, etc.). */
export interface RiderCategory {
  rider_category_id: string;
  rider_category_name: string;
  is_default_fare_category?: 0 | 1;
  eligibility_url?: string;
}

/** fare_media.txt — payment medium (cash, contactless, smart card, etc.). */
export interface FareMedia {
  fare_media_id: string;
  fare_media_name?: string;
  /**
   * 0 = no fare media (cash, equivalent),
   * 1 = physical paper ticket,
   * 2 = physical transit card,
   * 3 = cEMV (contactless),
   * 4 = mobile app.
   */
  fare_media_type: 0 | 1 | 2 | 3 | 4;
}

/** fare_products.txt — the actual purchasable product (ticket, pass, transfer). */
export interface FareProduct {
  fare_product_id: string;
  fare_product_name?: string;
  rider_category_id?: string;
  fare_media_id?: string;
  amount: string;
  currency: string;
}

/**
 * fare_leg_rules.txt — describes the fare for a single leg of travel.
 * Joins areas + networks + timeframes + rider categories to fare products.
 */
export interface FareLegRule {
  leg_group_id?: string;
  network_id?: string;
  from_area_id?: string;
  to_area_id?: string;
  from_timeframe_group_id?: string;
  to_timeframe_group_id?: string;
  fare_product_id: string;
  rule_priority?: number;
}

/**
 * fare_transfer_rules.txt — discounts or rules applied to transfers between
 * legs. Distinct from transfers.txt: this is pricing, not routing.
 */
export interface FareTransferRule {
  from_leg_group_id?: string;
  to_leg_group_id?: string;
  /** -1 = unlimited, else ≥ 1. Required iff from == to leg group; forbidden otherwise. */
  transfer_count?: number;
  duration_limit?: number; // seconds
  /**
   * Required iff duration_limit is set. Where the limit is measured from/to:
   * 0 = departure of the current leg → arrival of the next leg,
   * 1 = departure of the current leg → departure of the next leg,
   * 2 = arrival of the current leg → departure of the next leg,
   * 3 = arrival of the current leg → arrival of the next leg.
   */
  duration_limit_type?: 0 | 1 | 2 | 3;
  /**
   * How the cost is computed (A = first leg, B = next leg, AB = this rule's
   * fare_product_id):
   * 0 = A + AB (pay the first leg plus the transfer product),
   * 1 = A + AB + B (pay both legs plus the transfer product),
   * 2 = AB (the transfer product replaces both legs).
   */
  fare_transfer_type: 0 | 1 | 2;
  /** Optional for every type: empty means the transfer itself costs 0. */
  fare_product_id?: string;
}

/**
 * translations.txt — a translated value for one text-like field, in one
 * language (https://gtfs.org/documentation/schedule/reference/#translationstxt).
 *
 * Two mutually exclusive ways to say WHICH value is translated:
 *  - by record: `record_id` (+ `record_sub_id` for stop_times, where it is the
 *    stop_sequence) names one row of `table_name`;
 *  - by value: `field_value` translates every row whose `field_name` equals it
 *    exactly (e.g. every trip_headsign "Downtown").
 * Neither is used for feed_info (a single-row table). A row naming a record
 * wins over a by-value row for the same field.
 *
 * Rows are kept exactly as imported — including ones the editor can't resolve
 * (an unofficial table, a record that doesn't exist). Validation explains them
 * and the exporter leaves out the ones that would make translations.txt
 * invalid (see services/translations.ts `exportableTranslations`).
 */
export interface Translation {
  table_name: string;
  field_name: string;
  /** IETF BCP 47 language tag, e.g. "es", "fr-CA", "zh-Hant". */
  language: string;
  translation: string;
  record_id?: string;
  record_sub_id?: string;
  field_value?: string;
}
