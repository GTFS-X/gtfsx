import type { StateCreator } from 'zustand';
import type { PassthroughFile } from '../services/feedPassthrough';

/**
 * Files from the imported ZIP that the editor doesn't model, kept verbatim and
 * written back unchanged on every export (services/feedPassthrough.ts). Not
 * editable and not undoable — set only when a feed is loaded or replaced.
 */
export interface PassthroughSlice {
  passthroughFiles: PassthroughFile[];
  setPassthroughFiles: (files: PassthroughFile[]) => void;
}

export const createPassthroughSlice: StateCreator<
  PassthroughSlice,
  [['zustand/immer', never]],
  [],
  PassthroughSlice
> = (set) => ({
  passthroughFiles: [],
  setPassthroughFiles: (files) => set((state) => { state.passthroughFiles = files; }),
});
