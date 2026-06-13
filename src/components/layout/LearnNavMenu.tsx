import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { LEARN_ARTICLES } from '../../lib/learnArticles';

/**
 * Top-nav "Learn" dropdown for the SPA marketing header (CommunityRoot, HelpPage).
 *
 * There is no /learn/ index, so the trigger does not navigate — it opens a menu
 * of the learn articles (which are static pages, hence full-page <a> links).
 *
 * Mirrors the editor's FloatingHelp hover-menu pattern (Radix Popover + a small
 * hover-intent delay) so the chrome feels consistent.
 *
 * Accessibility:
 *   - Trigger: aria-haspopup="menu" + aria-expanded (Radix manages expanded).
 *   - Opens on hover (intent delay), click, and keyboard (Enter/Space/ArrowDown).
 *   - Content is role="menu"; items are role="menuitem" and arrow/Home/End
 *     navigable; Escape and outside-click close (Radix built-in), returning
 *     focus to the trigger.
 */
export function LearnNavMenu({ triggerClassName }: { triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const cancelOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const scheduleOpen = () => {
    cancelClose();
    openTimer.current = setTimeout(() => setOpen(true), 120);
  };
  const scheduleClose = () => {
    cancelOpen();
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const triggerCls =
    triggerClassName ??
    'text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream transition-colors';

  // Roving focus among the menu items via arrow keys / Home / End.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]'))
      : [];
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={`inline-flex items-center gap-1 ${triggerCls}`}
        >
          Learn
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          role="menu"
          aria-label="Learn"
          side="bottom"
          align="start"
          sideOffset={6}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onKeyDown={onMenuKeyDown}
          onOpenAutoFocus={(e) => {
            // Focus the first item so arrow keys work immediately.
            e.preventDefault();
            contentRef.current
              ?.querySelector<HTMLAnchorElement>('[role="menuitem"]')
              ?.focus();
          }}
          className="z-50 bg-white rounded-xl shadow-lg border border-sand p-1.5 min-w-[230px] outline-none"
        >
          {LEARN_ARTICLES.map((article) => (
            <a
              key={article.path}
              href={article.path}
              role="menuitem"
              className="block px-3 py-2 rounded-lg text-sm font-semibold text-dark-brown hover:bg-cream hover:text-coral focus-visible:bg-cream focus-visible:text-coral focus-visible:outline-none transition-colors"
            >
              {article.title}
            </a>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
