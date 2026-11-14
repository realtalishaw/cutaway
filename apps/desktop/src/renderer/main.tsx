import './bridge';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Test hook: only present when the app is launched by the e2e harness (CUTAWAY_E2E=1).
if (new URLSearchParams(window.location.search).has('e2e')) {
  void Promise.all([import('./state/store'), import('./state/actions'), import('./state/jobs'), import('./engine/exporter'), import('@cutaway/core'), import('./state/recording'), import('./engine/packageExport'), import('./jobs'), import('./state/shorts')]).then(([store, actions, jobs, exporter, core, recording, packageExport, pipeline, shorts]) => {
    (window as unknown as { __cutaway: unknown }).__cutaway = { ...store, actions, jobs, exporter, core, recording, packageExport, pipeline, shorts };
  });
}

createRoot(document.getElementById('root')!).render(<App />);
