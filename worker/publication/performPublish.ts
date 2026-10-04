// Shared publish core, reused by the interactive publish route
// (worker/projects/routes.ts) and the scheduled-publish cron
// (worker/cron/tasks.ts). Given an already-resolved project + snapshot and the
// caller's chosen flags, it runs the ID-stability check, copies the rendered
// ZIP into the publication slot, flips the `publication` pointer, appends
// history + audit, and kicks off the background catalog + thumbnail work.
//
// Callers own access/quota gating (requirePublishAccess) and body parsing — this
// function performs the publish itself, identically for both paths.
import { ulid } from 'ulidx';
import type { Env } from '../env';
import { assertIdStable } from './idStability';
import { submitToCatalogs } from './submit';
import {
  stopBoundingBox,
  deriveCatalogFeatures,
  deriveImportedMdbSourceId,
  type CatalogMeta,
} from './catalog';
import { getFeedBlob, publicationZipKey, putFeedBlob } from '../projects/r2';
import { loadFeedStateFromKey, maybeRegenerateThumbnail } from '../embeds/thumbnail';
import { logAudit } from '../util/audit';
import { conflict, validationFailed, notFound } from '../util/errors';

export interface PublishProject {
  id: string;
  slug: string;
  name: string;
}
export interface PublishSnapshot {
  id: string;
  state_r2_key: string;
  zip_r2_key: string | null;
  validation_errors: number;
  validation_warnings: number;
}

export interface PerformPublishInput {
  project: PublishProject;
  snapshot: PublishSnapshot;
  /** Currently-published row for the project (null if first publish). */
  existingPublication: { snapshot_id: string } | null;
  ignoreWarnings?: boolean;
  ignoreRtBreakage?: boolean;
  /** Acknowledges the agency_id-churn warning (C2). */
  ignoreAgencyChurn?: boolean;
  /**
   * SPDX license identifier to record on `feed_project` as part of this
   * publish. `undefined` leaves the stored value untouched (the cron path never
   * supplies it); `null` clears it.
   *
   * There is no NTD ID here: it lives on the agency, inside the feed
   * (agency.external_id), so it arrives with the snapshot state and is read
   * per-agency by the feeds origin.
   */
  licenseSpdx?: string | null;
  /** Null for system/cron-initiated publishes. */
  actorUserId: string | null;
  /** Interactive multipart path supplies the freshly-rendered ZIP; the cron
   *  omits it so we copy the snapshot's stored zip_r2_key. */
  incomingZip?: ArrayBuffer | null;
  /** With no incomingZip: the R2 key to publish from, overriding the
   *  snapshot's zip_r2_key. Rollback passes the snapshot's existing
   *  publication slot when it is still there (then nothing is copied). */
  sourceZipKey?: string | null;
  /** What this publish is, for the history row and the audit's `rollback`
   *  flag. Explicit, because "a different snapshot than the live one" is
   *  every forward republish too. Default 'publish'. */
  historyAction?: 'publish' | 'rollback';
  feedsOrigin: string;
  /** Defer catalog + thumbnail work. Route passes c.executionCtx.waitUntil;
   *  the cron passes a function that awaits inline (latency doesn't matter). */
  runBackground: (p: Promise<unknown>) => void;
  ip?: string | null;
  now?: number;
}

export interface PerformPublishResult {
  publishedBytes: number;
  canonicalUrl: string;
}

/**
 * The public feed URL (FEEDS_ORIGIN/<slug>/gtfs.zip) is global, but project
 * slugs are only unique per owner. Refuse to publish at a slug another project
 * already publishes: otherwise the two would share one URL, and which ZIP is
 * served would flip whenever the first owner unpublished and republished.
 */
export async function assertCanonicalSlugFree(env: Env, slug: string, projectId: string): Promise<void> {
  const taken = await env.DB.prepare(
    `SELECT project_id FROM publication WHERE canonical_slug = ? AND project_id <> ? LIMIT 1`,
  )
    .bind(slug, projectId)
    .first<{ project_id: string }>();
  if (taken) {
    throw conflict(
      `Another feed is already published at /${slug}. Change this feed's URL slug before publishing.`,
      { reason: 'slug_taken', slug },
    );
  }
}

export async function performPublish(env: Env, input: PerformPublishInput): Promise<PerformPublishResult> {
  const { project, snapshot, existingPublication, actorUserId, incomingZip, feedsOrigin, runBackground } = input;
  const ignoreWarnings = input.ignoreWarnings ?? false;
  const ignoreRtBreakage = input.ignoreRtBreakage ?? false;
  const ignoreAgencyChurn = input.ignoreAgencyChurn ?? false;
  const historyAction = input.historyAction ?? 'publish';
  const now = input.now ?? Date.now();

  // Global URL guard — before anything is written.
  await assertCanonicalSlugFree(env, project.slug, project.id);

  // Validation gate: errors block publish unless ignoreWarnings=true.
  if (snapshot.validation_errors > 0 && !ignoreWarnings) {
    throw validationFailed('Feed has validation errors. Fix them or pass ignoreWarnings=true to publish anyway.', {
      validationErrors: snapshot.validation_errors,
      validationWarnings: snapshot.validation_warnings,
    });
  }

  // ─── ID-stability gates (rt_breakage BE-88 + agency_id_churn C2) ────────────
  //
  // One shared evaluation (worker/publication/idStability.ts → assertIdStable),
  // also run by the schedule endpoint at SCHEDULE time so a scheduled publish is
  // acknowledged while the user is still at the keyboard. The cron replays those
  // persisted acknowledgements through here — so a gate that fires at fire time
  // means the diff CHANGED since scheduling (someone published something else in
  // between, moving the baseline), and the schedule correctly fails.
  await assertIdStable(env, {
    projectId: project.id,
    snapshot,
    existingPublication,
    ignoreRtBreakage,
    ignoreAgencyChurn,
  });

  // Copy the rendered ZIP into the publication slot in R2.
  const pubKey = publicationZipKey(project.id, snapshot.id);
  let publishedBytes: number;
  if (incomingZip) {
    await putFeedBlob(env, pubKey, incomingZip, { contentType: 'application/zip' });
    publishedBytes = incomingZip.byteLength;
  } else {
    const sourceKey = input.sourceZipKey ?? snapshot.zip_r2_key;
    if (!sourceKey) {
      throw validationFailed('This snapshot has no rendered ZIP. Publish with multipart form instead.');
    }
    if (sourceKey === pubKey) {
      // Already in the publication slot (rolling back onto a snapshot that
      // was published before) — nothing to copy.
      const head = await env.FEEDS.head(pubKey);
      if (!head) throw notFound('Rendered ZIP missing from storage');
      publishedBytes = head.size;
    } else {
      const source = await getFeedBlob(env, sourceKey);
      if (!source) throw notFound('Rendered ZIP missing from storage');
      const buf = await source.arrayBuffer();
      publishedBytes = buf.byteLength;
      await putFeedBlob(env, pubKey, buf, { contentType: 'application/zip' });
    }
  }

  // Record the feed's license on feed_project (migration 0024) — the copy the
  // public feeds origin serves in feed_info.json + dmfr.json. Only written when
  // the caller supplied it: the cron path omits it and must not clobber what the
  // last interactive publish set.
  if (input.licenseSpdx !== undefined) {
    await env.DB.prepare(`UPDATE feed_project SET license_spdx = ? WHERE id = ?`)
      .bind(input.licenseSpdx, project.id)
      .run();
  }

  // Upsert publication + append history.
  await env.DB.prepare(
    `INSERT INTO publication (project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       snapshot_id = excluded.snapshot_id,
       published_by_user_id = excluded.published_by_user_id,
       published_at = excluded.published_at,
       canonical_slug = excluded.canonical_slug,
       zip_r2_key = excluded.zip_r2_key`,
  )
    .bind(project.id, snapshot.id, actorUserId, now, project.slug, pubKey)
    .run();

  await env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, snapshot_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), project.id, snapshot.id, historyAction, actorUserId, now)
    .run();

  await logAudit(env, {
    actorUserId,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.publish',
    metadata: { snapshotId: snapshot.id, size: publishedBytes, rollback: historyAction === 'rollback' },
    ip: input.ip ?? null,
  });

  // Auto-submit to opted-in catalogs (BE-80/83) + refresh the thumbnail. Both
  // off the response path; neither breaks publish.
  runBackground(
    submitToCatalogs(env, {
      projectId: project.id,
      slug: project.slug,
      feedsOrigin,
      feedTitle: project.name,
    }).catch((err) => {
      console.error('[publish] catalog submission error', err);
    }),
  );
  runBackground(
    (async () => {
      const state = await loadFeedStateFromKey(env, snapshot.state_r2_key);
      if (state) await maybeRegenerateThumbnail(env, project.id, state);
    })().catch((err) => console.error('[thumbnail] publish-trigger error', err)),
  );

  // Persist the per-feed catalog metadata (bbox, features, feed_publisher_name,
  // feed_contact_email) that feeds.<zone>/catalog.json needs, computed ONCE
  // here from the snapshot state so the catalog route reads D1 only and never
  // loads N feed blobs per request (issue #47). Off the response path; failure
  // never breaks publish — the catalog just omits the fields it couldn't fill.
  runBackground(
    computeAndStoreCatalogMeta(env, project.id, snapshot.id, snapshot.state_r2_key).catch((err) =>
      console.error('[publish] catalog-meta error', err),
    ),
  );

  const canonicalUrl = `${feedsOrigin.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return { publishedBytes, canonicalUrl };
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/**
 * Compute the catalog metadata for a just-published feed from its snapshot
 * state and store it on the publication row (publication.catalog_meta_json).
 * Best-effort: a missing or unreadable state leaves the column untouched (the
 * catalog route degrades gracefully). Loads the state blob independently of the
 * thumbnail task so it stays fully decoupled from that path.
 *
 * Runs in the background, so two quick publishes can finish out of order: the
 * UPDATE is keyed on the snapshot too, so an older snapshot's late result never
 * overwrites the meta of the one that is live now.
 *
 * Exported for tests.
 */
export async function computeAndStoreCatalogMeta(
  env: Env,
  projectId: string,
  snapshotId: string,
  stateKey: string,
): Promise<void> {
  const blob = await getFeedBlob(env, stateKey);
  if (!blob) return;
  let raw: unknown;
  try {
    const text = await new Response(blob.body.pipeThrough(new DecompressionStream('gzip'))).text();
    raw = JSON.parse(text);
  } catch {
    return; // unreadable state — leave catalog_meta_json as-is
  }
  const state = raw as {
    stops?: Array<{ stop_lat?: unknown; stop_lon?: unknown }>;
    feedInfo?: { feed_publisher_name?: unknown; feed_contact_email?: unknown } | null;
  };
  const feedInfo = state.feedInfo ?? null;
  const meta: CatalogMeta = {
    bbox: stopBoundingBox(state.stops),
    features: deriveCatalogFeatures(raw),
    feedPublisherName: strOrNull(feedInfo?.feed_publisher_name),
    feedContactEmail: strOrNull(feedInfo?.feed_contact_email),
  };
  await env.DB.prepare(`UPDATE publication SET catalog_meta_json = ? WHERE project_id = ? AND snapshot_id = ?`)
    .bind(JSON.stringify(meta), projectId, snapshotId)
    .run();

  // Project the Mobility Database import provenance carried in the feed state
  // (store field `mdbSourceId`) onto feed_project.mdb_source_id — the "switcher"
  // id the open catalog emits so MDB updates an existing source instead of
  // duplicating it (issue #47). COALESCE keeps it first-write-wins: we only fill
  // a NULL column, so a value set manually/out-of-band or by an earlier publish
  // is never overwritten, and a feed with no MDB provenance is left untouched
  // (never nulled). Only runs when the snapshot actually carries a source id.
  const importedMdbSourceId = deriveImportedMdbSourceId(raw);
  if (importedMdbSourceId != null) {
    await env.DB.prepare(
      `UPDATE feed_project SET mdb_source_id = COALESCE(mdb_source_id, ?) WHERE id = ?`,
    )
      .bind(importedMdbSourceId, projectId)
      .run();
  }
}
