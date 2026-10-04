import { useStore } from '../../store';
import {
  createProject,
  saveWorkingState,
  type ProjectSummary,
} from '../../services/projectsApi';
import {
  buildWorkingStateSnapshot,
  captureSavedDataRefs,
  markSavedIfUnchanged,
  setCurrentWorkingStateVersion,
} from '../../db/serverPersistence';

export type NewFeedOwner = { type: 'user' } | { type: 'org'; id: string };

/** Holds the project created by a first attempt so a retry doesn't make a duplicate. */
export interface CreatedFeedRef {
  current: { project: ProjectSummary; ownerKey: string } | null;
}

/**
 * Create a server project and save the editor's current working state into it
 * (Save As, and "create from import" on My Feeds / Org settings).
 *
 * - Idempotent across retries (C4-05): if `createProject` succeeded but the
 *   PUT failed, the next call reuses the created project instead of making a
 *   second one. A different owner on retry starts fresh.
 * - Serializes the baseline plus the `__variants` envelope (C4-03), not the
 *   live experiment as the baseline.
 * - Captures the data refs before the snapshot and marks the store saved only
 *   if nothing changed while the PUT was in flight (S1-01).
 */
export async function saveCurrentFeedAsNew(opts: {
  name: string;
  owner: NewFeedOwner;
  created: CreatedFeedRef;
}): Promise<{ project: ProjectSummary; workingStateVersion: number }> {
  const ownerKey = opts.owner.type === 'org' ? `org:${opts.owner.id}` : 'user';
  let project = opts.created.current?.ownerKey === ownerKey ? opts.created.current.project : null;
  if (!project) {
    project = await createProject({ name: opts.name, owner: opts.owner });
    opts.created.current = { project, ownerKey };
  }
  const st = useStore.getState();
  // Reflect the new server-backed identity in the store so the snapshot we
  // serialize carries the right project id.
  st.setProjectId(project.id);
  st.setProjectName(project.name);

  const refs = captureSavedDataRefs();
  const snapshot = buildWorkingStateSnapshot();
  const { workingStateVersion } = await saveWorkingState(project.id, snapshot, 0);
  setCurrentWorkingStateVersion(project.id, workingStateVersion);
  const after = useStore.getState();
  after.setActiveServerProject(project.id);
  after.upsertFeedProject({ ...project, workingStateVersion });
  markSavedIfUnchanged(refs);
  return { project, workingStateVersion };
}
