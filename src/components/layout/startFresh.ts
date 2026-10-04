import { useStore } from '../../store';
import { db } from '../../db/dexie';

/** Where "start a new project" lands: the editor, never '/'. For a logged-out
 *  user the Worker serves the marketing page at '/' (C3-21). */
export function freshEditorUrl(base: string = import.meta.env.BASE_URL): string {
  return `${base}editor`;
}

function hardNavigate(url: string) {
  window.location.href = url;
}

/**
 * Discard the current project and hard-load a clean editor (TopBar's
 * "Discard & Reset" and the logo's clean path). Hard-load rather than reload():
 * on /feeds/:slug a reload would just re-open the same feed.
 *
 * The editor is marked clean first so the beforeunload guard doesn't ask the
 * user to confirm the discard they just confirmed (C3-21).
 */
export async function discardAndStartFresh(go: (url: string) => void = hardNavigate): Promise<void> {
  await db.projectData.clear();
  await db.projectBulk.clear();
  await db.projects.clear();
  useStore.getState().markSaved();
  go(freshEditorUrl());
}
