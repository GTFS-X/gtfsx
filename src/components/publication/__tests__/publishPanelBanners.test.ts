// E2E S2: every PublishPanel action set its result banner ("Feed published.",
// "Scheduled to publish on…", "Scheduled publish cancelled.", "Feed
// unpublished… the scheduled publish was cancelled.", "Publication restored.")
// and then awaited refresh(), which began with setBanner(null) and wiped it.
// Static contract: refresh() leaves the banner alone; only a project change
// clears it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../PublishPanel.tsx', import.meta.url)), 'utf8');

describe('PublishPanel banners survive the post-action refresh', () => {
  it('refresh() does not clear the banner', () => {
    const start = src.indexOf('const refresh = useCallback(async () => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}, [projectId', start));
    expect(body).not.toMatch(/setBanner\(null\)/);
  });

  it('a project change clears the banner before loading', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setBanner\(null\);\s*refresh\(\);\s*\}, \[refresh\]\);/);
  });

  it('each action sets its banner and then refreshes', () => {
    for (const handler of ['const handleUnpublish', 'const handleRollback', 'const handleCancelSchedule', 'const runAction']) {
      const i = src.indexOf(handler);
      expect(i).toBeGreaterThan(-1);
      const body = src.slice(i, src.indexOf('\n  };\n', i));
      const lastBanner = body.lastIndexOf("kind: 'success'") > -1 ? body.lastIndexOf("kind: 'success'") : body.indexOf("kind: 'info'");
      expect(lastBanner).toBeGreaterThan(-1);
      expect(body.indexOf('await refresh()', lastBanner)).toBeGreaterThan(lastBanner);
    }
  });
});
