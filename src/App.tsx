import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { setupAutoSave, loadProject } from './db/persistence';
import { useStore } from './store';

function App() {
  useEffect(() => {
    // Try to load last project
    const projectId = useStore.getState().projectId;
    loadProject(projectId).catch(() => {});

    // Set up auto-save
    const unsub = setupAutoSave();
    return unsub;
  }, []);

  return <AppShell />;
}

export default App;
