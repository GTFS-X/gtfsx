import { html, raw } from 'hono/html';
import { mapboxAssetTags } from './map';

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: #fff8f0;
    line-height: 1.5;
    font-size: 14px;
  }
  .embed-root {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
  }
  header.embed-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .route-badge {
    display: inline-block;
    min-width: 36px;
    text-align: center;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 14px;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 700; }
  h3 { font-size: 14px; margin: 16px 0 8px; font-weight: 600; }
  .effective {
    font-size: 12px;
    color: #6b6b6b;
    margin-top: 2px;
  }
  .map {
    width: 100%;
    height: 360px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #e8d8c0;
    margin-bottom: 16px;
    background: #f0e6d4;
  }
  .map-fallback {
    width: 100%;
    height: 200px;
    display: grid;
    place-items: center;
    color: #6b6b6b;
    background: #f0e6d4;
    border-radius: 8px;
    margin-bottom: 16px;
  }
  .service-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    border-bottom: 1px solid #e8d8c0;
  }
  .service-tabs a {
    padding: 8px 14px;
    text-decoration: none;
    color: #1a1a1a;
    font-size: 13px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .service-tabs a.active {
    border-bottom-color: #e8734a;
    color: #b04d2a;
    font-weight: 700;
  }
  .schedule-scroll {
    overflow-x: auto;
    border: 1px solid #e8d8c0;
    border-radius: 6px;
    background: #fff;
  }
  table.schedule {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  table.schedule th, table.schedule td {
    padding: 6px 10px;
    text-align: right;
    border-bottom: 1px solid #f0e6d4;
    border-right: 1px solid #f0e6d4;
    white-space: nowrap;
  }
  table.schedule thead th {
    background: #fff8f0;
    border-bottom: 1px solid #e8d8c0;
    position: sticky;
    top: 0;
    z-index: 1;
    font-weight: 600;
    color: #6b6b6b;
  }
  table.schedule .corner { background: #fff8f0; left: 0; position: sticky; z-index: 2; }
  table.schedule .stop-name {
    text-align: left;
    font-weight: 500;
    color: #1a1a1a;
    background: #fff;
    position: sticky;
    left: 0;
    z-index: 1;
    border-right: 2px solid #e8d8c0;
    min-width: 160px;
  }
  table.schedule .skip { color: #c0a890; }
  .empty {
    color: #6b6b6b;
    font-style: italic;
    padding: 16px;
    text-align: center;
  }
  footer.embed-footer {
    margin-top: 16px;
    font-size: 11px;
    color: #6b6b6b;
    text-align: right;
  }
  footer.embed-footer a { color: #6b6b6b; }
  .route-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
    margin-top: 12px;
  }
  .route-list a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    text-decoration: none;
    color: #1a1a1a;
    background: #fff;
    border: 1px solid #e8d8c0;
    border-radius: 6px;
    font-size: 13px;
  }
  .route-list a:hover { background: #fff8f0; }
`;

export function renderLayout(opts: {
  title: string;
  bodyClass?: string;
  body: ReturnType<typeof html>;
}) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${opts.title}</title>
  <style>${raw(STYLES)}</style>
  ${mapboxAssetTags()}
</head>
<body class="${opts.bodyClass ?? ''}">
  <div class="embed-root">${opts.body}</div>
</body>
</html>`;
}

export function embedHeaders(versionId: string, publishedAt: number): Headers {
  const h = new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('ETag', `"${versionId}"`);
  h.set('Last-Modified', new Date(publishedAt).toUTCString());
  // Embeds are publicly framable.
  h.set('Content-Security-Policy', "frame-ancestors *;");
  // Don't outrank the host page in search.
  h.set('X-Robots-Tag', 'noindex');
  // Tile + edge cache: short browser TTL, longer at the edge; republish
  // invalidates by version_id changing the ETag.
  h.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return h;
}
