import type { BottomPanelTab } from '../../types/ui';

const LOCAL_TABS = ['timetable', 'blocks', 'service-summary', 'validation'] as const;
const SERVER_TABS = [...LOCAL_TABS, 'snapshots', 'publish', 'embed', 'audit'] as const;

/** Tabs the bottom panel offers. The server-only ones (snapshots, publish,
 *  embed, audit) need an active server project. */
export function bottomPanelTabs(hasServerProject: boolean): readonly BottomPanelTab[] {
  return hasServerProject ? SERVER_TABS : LOCAL_TABS;
}

/** The tab actually shown: a stored tab that isn't available (e.g. 'snapshots'
 *  on a locked or local feed) falls back to the timetable instead of rendering
 *  an empty panel with nothing highlighted (C3-23). */
export function effectiveBottomTab(tab: BottomPanelTab, hasServerProject: boolean): BottomPanelTab {
  return bottomPanelTabs(hasServerProject).includes(tab) ? tab : 'timetable';
}
