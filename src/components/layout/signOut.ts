import { useStore } from '../../store';
import { loadingFeed } from '../../store/history';
import { resetEditorState } from '../../db/serverPersistence';
import { db } from '../../db/dexie';
import { STAFF_IMPERSONATOR_KEY } from '../../services/adminApi';

function freshProjectId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Drop everything the signed-in user had loaded, then clear auth (C3-03).
 *
 * `clearAuth()` alone only nulls the user and their orgs: the previous user's
 * feed stayed in the editor under its old projectId, and the next edit was
 * autosaved to this browser's IndexedDB. Every explicit sign-out goes through
 * here instead, so a shared machine is left with an empty editor and no local
 * copy of the feed. Also forgets the staff impersonation hint (C4-15), which
 * nothing else ever cleared.
 *
 * Deliberately NOT folded into clearAuth: a future session-expiry path may call
 * clearAuth mid-edit and must not wipe unsaved work.
 */
export async function signOutLocally(): Promise<void> {
  loadingFeed(() => resetEditorState());
  const state = useStore.getState();
  state.setActiveServerProject(null);
  state.setFeedsProjects([], null);
  useStore.setState((s) => {
    s.projectId = freshProjectId();
    s.projectName = 'Untitled Feed';
  });
  // Separate update: the history middleware stamps isDirty on any change to
  // persisted keys (the reset above included), and an emptied editor has
  // nothing unsaved, so beforeunload must not prompt.
  useStore.setState({ isDirty: false });
  try {
    localStorage.removeItem(STAFF_IMPERSONATOR_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
  try {
    await Promise.all([db.projects.clear(), db.projectData.clear(), db.projectBulk.clear()]);
  } catch (err) {
    console.warn('[signOutLocally] local project wipe failed', err);
  }
  useStore.getState().clearAuth();
}
