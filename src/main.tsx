import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Remove any server-rendered SEO snapshot before the SPA mounts. The worker
// injects a [data-prerendered] block for hard-loads of /community/* (forum)
// and /pricing, /demo (marketing) so search engines and no-JS readers see
// indexable content; once the SPA bundle runs, the live UI replaces it.
// See worker/forum/dispatcher.ts and worker/marketing/ssr.ts.
document.querySelectorAll('[data-prerendered]').forEach((el) => el.remove());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
