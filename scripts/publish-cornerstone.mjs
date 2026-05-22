// One-time content publisher: converts 6 approved markdown drafts (frontmatter +
// GFM body) into static HTML pages stamped onto the public/learn/gtfs-flex/
// template. Run after editing any draft to re-publish the corresponding page.
//
//   node scripts/publish-cornerstone.mjs
//
// Source drafts live outside the repo (Google Drive), enumerated below by
// absolute path. Output paths follow handoffs/publish-cornerstone-content.md
// — public/learn/publish-gtfs-feed/, public/compare/<slug>/, public/use-cases/<slug>/.
//
// Mirrors the gtfs-flex/index.html template exactly (site-header, footer,
// progressive-enhancement user-slot script). Adds CSS for tables, fenced
// code, and h3 — features the template proper doesn't use but the cornerstone
// drafts do. Schema.org: Article for /learn and /compare, WebPage for
// /use-cases.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRAFTS = '/Users/clippy2/Library/CloudStorage/GoogleDrive-mark@eateggs.com/My Drive/Vector & Vertex/GTFS Builder/Cornerstone Content Drafts';
const SITE = 'https://www.gtfsx.com';
const DRAFT_VERSION = 'v1, 2026-05-22';

// ──── Page manifest ────────────────────────────────────────────────────────
// Each entry: source draft file, target index.html path (relative to repo),
// public URL path (used for canonical / og:url / sitemap), schema.org @type,
// and which top-level nav item (if any) should get the .active class.
const PAGES = [
  {
    src: 'learn-publish-gtfs-feed.md',
    out: 'public/learn/publish-gtfs-feed/index.html',
    url: '/learn/publish-gtfs-feed/',
    schemaType: 'Article',
    activeNav: '/learn/gtfs/',
  },
  {
    src: 'compare-gtfs-builder-rtap.md',
    out: 'public/compare/gtfs-builder-rtap/index.html',
    url: '/compare/gtfs-builder-rtap/',
    schemaType: 'Article',
    activeNav: null,
  },
  {
    src: 'compare-spare-flex-builder.md',
    out: 'public/compare/spare-flex-builder/index.html',
    url: '/compare/spare-flex-builder/',
    schemaType: 'Article',
    activeNav: null,
  },
  {
    src: 'compare-trillium.md',
    out: 'public/compare/trillium/index.html',
    url: '/compare/trillium/',
    schemaType: 'Article',
    activeNav: null,
  },
  {
    src: 'compare-remix.md',
    out: 'public/compare/remix/index.html',
    url: '/compare/remix/',
    schemaType: 'Article',
    activeNav: null,
  },
  {
    src: 'use-cases-state-dot.md',
    out: 'public/use-cases/state-dot/index.html',
    url: '/use-cases/state-dot/',
    schemaType: 'WebPage',
    activeNav: null,
  },
];

// ──── Frontmatter ──────────────────────────────────────────────────────────
// Parse just the keys we need — title, meta_description, target_url (also
// optionally og_title). Drafts use a simple `key: value` shape (one value
// per line, no nested mappings except `target_keywords:` which we ignore).
function parseFrontmatter(md) {
  if (!md.startsWith('---\n')) return { frontmatter: {}, body: md };
  const end = md.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: md };
  const raw = md.slice(4, end);
  const body = md.slice(end + 5);
  const fm = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (!m) continue;
    fm[m[1]] = m[2].trim();
  }
  return { frontmatter: fm, body };
}

// ──── HTML escaping helpers ────────────────────────────────────────────────
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escJson(s) {
  // Schema.org JSON-LD lives inside <script>...</script>; escape `<` so a
  // future description containing "</script" can't break out.
  return JSON.stringify(s).replace(/</g, '\\u003c');
}

// ──── Style block ──────────────────────────────────────────────────────────
// Mirror the gtfs-flex template's inline <style> verbatim, plus three
// additions called out by the handoff: table styling (drafts contain up to
// 14 tables per page), fenced-code <pre> styling (drafts have code blocks),
// and h3 sizing (the template inlines h3 styles per-instance; cornerstone
// pages use h3 too often for that to scale).
const INLINE_STYLE = `      :root { --bg:#FFF8F0; --ink:#2A1F18; --muted:#6B5A4D; --accent:#E8734A; --rule:#EADBC8; }
      * { box-sizing: border-box; }
      body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif; color:var(--ink); background:var(--bg); line-height:1.6; }
      footer, main { max-width: 760px; margin: 0 auto; padding: 0 24px; }
      /* ─── site header (matches the editor) ─── */
      .site-header { position: sticky; top: 0; z-index: 10; background:#fff; border-bottom:1px solid var(--rule); height:56px; display:flex; align-items:center; padding: 0 20px; gap:16px; }
      .site-header .brand { display:inline-flex; align-items:center; gap:10px; text-decoration:none; flex-shrink:0; }
      .site-header .brand img { height:36px; width:auto; }
      .site-header .brand-name { font-weight:800; font-size:1.5rem; color:var(--accent); letter-spacing:-0.01em; }
      .site-header nav { display:flex; gap:4px; margin-left:12px; }
      .site-header nav a { color:var(--muted); text-decoration:none; font-weight:600; font-size:14px; padding:8px 12px; border-radius:6px; transition:color 0.15s, background 0.15s; }
      .site-header nav a:hover { color:var(--ink); background:var(--bg); }
      .site-header nav a.active { color:var(--ink); background:var(--bg); }
      .site-header .actions { margin-left:auto; display:flex; align-items:center; gap:12px; }
      .site-header .cta { background:var(--accent); color:#fff; padding:8px 14px; border-radius:8px; text-decoration:none; font-weight:600; font-size:14px; }
      .site-header .cta:hover { filter:brightness(0.95); }
      .site-header .user-slot a { color:var(--muted); text-decoration:none; font-weight:600; font-size:14px; }
      .site-header .user-slot a:hover { color:var(--ink); }
      .site-header .user-slot .user-avatar { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; background:var(--accent); color:#fff; font-weight:800; font-size:13px; text-decoration:none; }
      .site-header .user-slot .user-avatar:hover { filter:brightness(0.95); }
      @media (max-width: 720px) {
        .site-header nav, .site-header .cta { display:none; }
        .site-header .brand-name { font-size:1.25rem; }
        .site-header .brand img { height:30px; width:auto; }
      }
      main { padding-top: 40px; padding-bottom: 60px; }
      h1 { font-size: 2.2rem; line-height:1.2; margin: 0 0 12px; }
      h2 { font-size: 1.4rem; margin-top: 2.2rem; }
      h3 { font-size: 1.1rem; margin-top: 1.6rem; }
      .lede { font-size: 1.15rem; color:var(--muted); }
      a { color: var(--accent); }
      ul { padding-left: 1.2rem; }
      li { margin: 0.3rem 0; }
      code { background:#fff; border:1px solid var(--rule); padding:1px 6px; border-radius:4px; font-size:0.9em; }
      pre { background:#fff; border:1px solid var(--rule); padding:12px 16px; border-radius:6px; overflow-x:auto; font-size:0.9em; line-height:1.45; }
      pre code { background:none; border:none; padding:0; }
      table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
      th, td { border: 1px solid var(--rule); padding: 8px 12px; text-align: left; vertical-align: top; }
      th { background: rgba(0,0,0,0.03); font-weight: 600; }
      footer { border-top: 1px solid var(--rule); padding-top:20px; padding-bottom:40px; color:var(--muted); font-size:0.95rem; display:flex; flex-wrap:wrap; gap:18px; }
      footer a { color: var(--muted); }`;

// ──── Site chrome (header + footer + user-slot script) ─────────────────────
// Verbatim from the template; only the active-nav class is parameterized.
function renderHeader(activeNav) {
  const navItem = (href, label) => {
    const cls = href === activeNav ? ' class="active"' : '';
    return `        <a href="${href}"${cls}>${label}</a>`;
  };
  return `    <header class="site-header">
      <a href="/" class="brand">
        <img src="/gtfsx-lockup.svg" alt="GTFS·X" />
      </a>
      <nav>
${navItem('/about/', 'About')}
${navItem('/docs/', 'Docs')}
${navItem('/learn/gtfs/', 'Learn')}
${navItem('/docs/deep-links/', 'Integrations')}
${navItem('/community', 'Community')}
${navItem('/help', 'Help')}
      </nav>
      <div class="actions">
        <a href="/" class="cta">Open editor</a>
        <div id="user-slot" class="user-slot">
          <a href="/login">Sign in</a>
        </div>
      </div>
    </header>`;
}

const FOOTER = `    <footer>
      <a href="/">Editor</a>
      <a href="/about/">About</a>
      <a href="/docs/">Docs</a>
      <a href="/learn/gtfs/">What is GTFS?</a>
      <a href="/learn/gtfs-flex/">What is GTFS-Flex?</a>
      <a href="/docs/deep-links/">Deep-link integration</a>
    </footer>
    <script>
      (function () {
        fetch('/api/me', { credentials: 'include', headers: { 'X-GB-Client': 'web' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data || !data.user) return;
            var slot = document.getElementById('user-slot');
            if (!slot) return;
            var label = data.user.displayName || data.user.email || '';
            var initial = (label.charAt(0) || '?').toUpperCase();
            var escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            slot.innerHTML = '<a href="/account" class="user-avatar" title="' + escaped + '">' + initial + '</a>';
          })
          .catch(function () { /* keep "Sign in" */ });
      })();
    </script>`;

// ──── marked setup ─────────────────────────────────────────────────────────
// gfm: true enables GFM tables (the drafts depend on this). headerIds: false
// because the cornerstone pages don't deep-link to headings; cleaner output.
marked.setOptions({ gfm: true, headerIds: false, mangle: false, breaks: false });

// ──── Per-page render ──────────────────────────────────────────────────────
function renderPage(page) {
  const md = readFileSync(`${DRAFTS}/${page.src}`, 'utf8');
  const { frontmatter: fm, body } = parseFrontmatter(md);
  const title = fm.title;
  const description = fm.meta_description;
  const targetUrl = fm.target_url || page.url;
  if (!title || !description) {
    throw new Error(`${page.src}: missing title or meta_description in frontmatter`);
  }
  if (targetUrl !== page.url) {
    throw new Error(`${page.src}: frontmatter target_url (${targetUrl}) ≠ manifest url (${page.url})`);
  }
  const canonical = `${SITE}${page.url}`;

  // Render body. marked emits an <h1> for the leading `# Heading`; that
  // becomes the page's single H1, satisfying the TICKET-H one-H1-per-page rule.
  const bodyHtml = marked.parse(body.trim());

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': page.schemaType,
    headline: title,
    url: canonical,
    description,
  };

  // Wrap the rendered body in <main>. Some drafts open with a one-line lede
  // paragraph — we don't auto-promote it to .lede because marked emits a
  // plain <p>. If we want lede styling later, the markdown can use a div
  // wrapper. Keep it simple for now.
  const main = `    <main>\n${bodyHtml.split('\n').map((l) => l ? `      ${l}` : '').join('\n').trimEnd()}\n    </main>`;

  const sourceComment = `    <!-- Source: Cornerstone Content Drafts/${page.src} (${DRAFT_VERSION}) -->`;

  return `<!doctype html>
<html lang="en">
  <head>
${sourceComment}
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
    <title>${escAttr(title)}</title>
    <meta name="description" content="${escAttr(description)}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:title" content="${escAttr(title)}" />
    <meta property="og:description" content="${escAttr(description)}" />
    <meta property="og:type" content="${page.schemaType === 'WebPage' ? 'website' : 'article'}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${SITE}/og-default.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@gtfsxapp" />
    <meta name="twitter:image" content="${SITE}/og-default.png" />
    <style>
${INLINE_STYLE}
    </style>
    <script type="application/ld+json">
    ${escJson(JSON.parse(JSON.stringify(jsonLd)))}
    </script>
  </head>
  <body>
${renderHeader(page.activeNav)}
${main}
${FOOTER}
  </body>
</html>
`;
}

// Pretty-print the JSON-LD so the source HTML stays readable; the schema
// validators don't care about whitespace, and matching the existing pages'
// formatting helps when diffing.
function prettyJsonLd(obj) {
  return JSON.stringify(obj, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '      ' + l))
    .join('\n')
    .replace(/</g, '\\u003c');
}

// The escJson helper above didn't end up doing the pretty-print job —
// override the JSON-LD render block here so the output indents nicely.
function renderJsonLd(obj) {
  return prettyJsonLd(obj);
}

// ──── Main ─────────────────────────────────────────────────────────────────
let ok = 0, failed = 0;
for (const page of PAGES) {
  try {
    let html = renderPage(page);
    // Replace the one-liner JSON-LD we emitted with the pretty-printed form.
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': page.schemaType,
      headline: readFileSync(`${DRAFTS}/${page.src}`, 'utf8').match(/^title:\s*(.+)$/m)?.[1]?.trim(),
      url: `${SITE}${page.url}`,
      description: readFileSync(`${DRAFTS}/${page.src}`, 'utf8').match(/^meta_description:\s*(.+)$/m)?.[1]?.trim(),
    };
    html = html.replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      `<script type="application/ld+json">\n    ${renderJsonLd(jsonLd)}\n    </script>`,
    );
    const outPath = resolve(root, page.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(`✓ ${page.out}`);
    ok++;
  } catch (err) {
    console.error(`✗ ${page.out}: ${err.message}`);
    failed++;
  }
}
console.log(`\n${ok} published · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
