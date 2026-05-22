// One-time maintenance script: ensure every server-rendered HTML page carries
// Open Graph image + Twitter card meta. Inserts a default-image block right
// after the existing `<meta property="og:url" ...>` line (every page already
// has one). Idempotent — skips files that already declare og:image. Re-run
// after adding a new static marketing/doc page.
//
//   node scripts/add-social-meta.mjs
//
// Per-page OG image overrides are a later iteration; for now all pages share
// /og-default.png (1200×630). See scripts/og-default.html for its source.

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  resolve(root, 'index.html'),
  ...globSync('public/**/index.html', { cwd: root }).map((p) => resolve(root, p)),
];

const SITE = 'https://www.gtfsx.com';

let changed = 0;
for (const file of files) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (html.includes('property="og:image"')) continue; // already done

  const m = html.match(/^([ \t]*)<meta property="og:url"[^>]*>\s*$/m);
  if (!m) {
    console.warn(`skip (no og:url anchor): ${file}`);
    continue;
  }
  const indent = m[1];
  const block =
    `\n${indent}<meta property="og:image" content="${SITE}/og-default.png" />` +
    `\n${indent}<meta property="og:image:width" content="1200" />` +
    `\n${indent}<meta property="og:image:height" content="630" />` +
    `\n${indent}<meta name="twitter:card" content="summary_large_image" />` +
    `\n${indent}<meta name="twitter:site" content="@gtfsxapp" />` +
    `\n${indent}<meta name="twitter:image" content="${SITE}/og-default.png" />`;
  html = html.replace(m[0], `${m[0]}${block}`);
  writeFileSync(file, html);
  changed++;
  console.log(`updated: ${file.replace(root + '/', '')}`);
}
console.log(`\n${changed} file(s) updated.`);
