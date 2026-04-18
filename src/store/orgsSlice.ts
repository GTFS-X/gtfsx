import type { StateCreator } from 'zustand';
import { listOrgs, type OrgRole, type OrgSummary } from '../services/orgsApi';

export type ActiveWorkspace =
  | { type: 'personal' }
  | { type: 'org'; orgId: string; role: OrgRole };

const STORAGE_KEY = 'gb_active_workspace';

function loadPersistedWorkspace(): ActiveWorkspace {
  if (typeof window === 'undefined') return { type: 'personal' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { type: 'personal' };
    const parsed = JSON.parse(raw) as ActiveWorkspace;
    if (parsed && parsed.type === 'org' && typeof parsed.orgId === 'string') {
      return parsed;
    }
    return { type: 'personal' };
  } catch {
    return { type: 'personal' };
  }
}

function persistWorkspace(ws: ActiveWorkspace): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
  } catch {
    // ignore
  }
}

export interface OrgsSlice {
  userOrgs: OrgSummary[];
  orgsLoaded: boolean;
  activeWorkspace: ActiveWorkspace;
  setUserOrgs: (orgs: OrgSummary[]) => void;
  upsertUserOrg: (org: OrgSummary) => void;
  removeUserOrg: (orgId: string) => void;
  setActiveWorkspace: (ws: ActiveWorkspace) => void;
  loadOrgs: () => Promise<void>;
  clearOrgs: () => void;
}

export const createOrgsSlice: StateCreator<
  OrgsSlice,
  [['zustand/immer', never]],
  [],
  OrgsSlice
> = (set, get) => ({
  userOrgs: [],
  orgsLoaded: false,
  activeWorkspace: loadPersistedWorkspace(),

  setUserOrgs: (orgs) =>
    set((state) => {
      state.userOrgs = orgs;
      state.orgsLoaded = true;
      const ws = state.activeWorkspace;
      if (ws.type === 'org') {
        const match = orgs.find((o) => o.id === ws.orgId);
        if (!match) {
          state.activeWorkspace = { type: 'personal' };
          persistWorkspace(state.activeWorkspace);
        } else if (match.role !== ws.role) {
          state.activeWorkspace = { type: 'org', orgId: match.id, role: match.role };
          persistWorkspace(state.activeWorkspace);
        }
      }
    }),

  upsertUserOrg: (org) =>
    set((state) => {
      const idx = state.userOrgs.findIndex((o) => o.id === org.id);
      if (idx === -1) state.userOrgs.unshift(org);
      else state.userOrgs[idx] = { ...state.userOrgs[idx], ...org };
    }),

  removeUserOrg: (orgId) =>
    set((state) => {
      state.userOrgs = state.userOrgs.filter((o) => o.id !== orgId);
      if (state.activeWorkspace.type === 'org' && state.activeWorkspace.orgId === orgId) {
        state.activeWorkspace = { type: 'personal' };
        persistWorkspace(state.activeWorkspace);
      }
    }),

  setActiveWorkspace: (ws) =>
    set((state) => {
      state.activeWorkspace = ws;
      persistWorkspace(ws);
    }),

  loadOrgs: async () => {
    try {
      const { orgs } = await listOrgs();
      get().setUserOrgs(orgs);
    } catch {
      set((state) => {
        state.userOrgs = [];
        state.orgsLoaded = true;
      });
    }
  },

  clearOrgs: () =>
    set((state) => {
      state.userOrgs = [];
      state.orgsLoaded = false;
      state.activeWorkspace = { type: 'personal' };
      persistWorkspace(state.activeWorkspace);
    }),
});
