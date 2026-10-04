// Store reset for rendered component tests. Snapshots the store's initial
// state the first time this module loads and restores it (replace=true)
// between tests, so each test starts from an empty project with no history.
import { useStore, type AppStore } from '../store';
import { resetHistory } from '../store/history';

const initial: AppStore = useStore.getState();

export function resetStore(patch: Partial<AppStore> = {}): void {
  useStore.setState({ ...initial, ...patch } as AppStore, true);
  resetHistory();
}

export const store = (): AppStore => useStore.getState();
