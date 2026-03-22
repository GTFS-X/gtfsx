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
    else state.feedInfo = updates as FeedInfo;
  }),
});
