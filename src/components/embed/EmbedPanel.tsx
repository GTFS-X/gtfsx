import { useMemo, useState } from 'react';
import { useStore } from '../../store';

const FEEDS_ORIGIN =
  (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
  (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
    ? 'https://staging-feeds.gtfsbuilder.net'
    : 'https://feeds.gtfsbuilder.net');

interface PublicationInfo {
  slug: string;
  versionId: string;
}

/**
 * "Embed" tab in the bottom panel. Lets the agency copy iframe snippets
 * for the system map and per-route embeds. Only visible after a feed is
 * published — embeds read from the canonical published version.
 */
export function EmbedPanel() {
  const routes = useStore((s) => s.routes);
  const currentPublication = useStore((s) => s.currentPublication);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);

  const project = activeServerProjectId
    ? feedsProjects.find((p) => p.id === activeServerProjectId)
    : null;

  const pub: PublicationInfo | null =
    project && currentPublication ? { slug: project.slug, versionId: currentPublication.versionId } : null;

  if (!pub) {
    return (
      <div className="p-6 text-sm text-warm-gray">
        Publish this feed first to get embeddable links. Once published, the system map and
        per-route widgets are available at{' '}
        <code className="text-coral">{FEEDS_ORIGIN}/&lt;slug&gt;/embed/...</code>.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto p-6 space-y-6">
      <SystemMapSnippet slug={pub.slug} />
      <RouteSnippets slug={pub.slug} routes={routes} />
    </div>
  );
}

function SystemMapSnippet({ slug }: { slug: string }) {
  const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/system-map`;
  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">System map</h3>
      <p className="text-xs text-warm-gray mb-2">
        An interactive map of every route + a clickable list of routes.
      </p>
      <CopyableSnippet
        label="iframe"
        snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="Transit system map"></iframe>`}
      />
      <PreviewLink url={url} />
    </section>
  );
}

function RouteSnippets({
  slug,
  routes,
}: {
  slug: string;
  routes: { route_id: string; route_short_name: string; route_long_name: string; route_color: string; route_text_color: string }[];
}) {
  const sorted = useMemo(
    () =>
      routes.slice().sort((a, b) => {
        const an = a.route_short_name || a.route_id;
        const bn = b.route_short_name || b.route_id;
        return an.localeCompare(bn, undefined, { numeric: true });
      }),
    [routes],
  );

  if (sorted.length === 0) {
    return (
      <section>
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
        <p className="text-xs text-warm-gray">No routes defined yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
      <p className="text-xs text-warm-gray mb-2">
        One iframe per route. Includes the route map, schedule table, and a service-day selector
        (defaults to today).
      </p>
      <div className="space-y-3">
        {sorted.map((r) => {
          const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}`;
          return (
            <div key={r.route_id} className="border border-sand rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs font-bold"
                  style={{
                    background: `#${r.route_color || 'cccccc'}`,
                    color: `#${r.route_text_color || '000000'}`,
                  }}
                >
                  {r.route_short_name || r.route_id}
                </span>
                <span className="text-sm text-dark-brown font-medium">{r.route_long_name}</span>
              </div>
              <CopyableSnippet
                label="iframe"
                snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="${escapeAttr(r.route_long_name || r.route_short_name || r.route_id)}"></iframe>`}
              />
              <PreviewLink url={url} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CopyableSnippet({ snippet }: { label: string; snippet: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — user can still select-and-copy.
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 text-[11px] font-mono bg-cream border border-sand rounded-md px-2 py-1.5 break-all">
        {snippet}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="px-3 py-1 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function PreviewLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block mt-2 text-xs text-coral font-semibold hover:underline"
    >
      Open preview →
    </a>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}
