import type { StateCreator } from 'zustand';
import type { FeedInfo } from '../types/gtfs';

export interface FeedInfoSlice {
  feedInfo: FeedInfo | null;
  setFeedInfo: (info: FeedInfo | null) => void;
  updateFeedInfo: (updates: Partial<FeedInfo>) => void;
}

export const createFeedInfoSlice: StateCreator<FeedInfoSlice, [['zustand/immer', never]], [], FeedInfoSlice> = (set) => ({
  feedInfo: null,
  setFeedInfo: (info) => set((state) => { state.feedInfo = info; }),
  updateFeedInfo: (updates) => set((state) => {
    if (state.feedInfo) Object.assign(state.feedInfo, updates);
    // A feed with no feed_info.txt gets one on first edit. The required slots
    // start blank: the exporter fills them (GTFS·X publisher, agency language).
    else state.feedInfo = { feed_publisher_name: '', feed_publisher_url: '', feed_lang: '', ...updates };
  }),
});
