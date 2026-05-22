import { useEffect, useRef } from 'react';
import { trackCtaClick } from '../../services/trackBeacon';

// Dialog that backs the Enterprise plan's "Talk to sales" CTA on /pricing.
// Replaces the previous straight-to-mailto link with a choice between
// booking a 30-min call (Fantastical) or sending an email — the email-only
// path was losing the agencies who'd rather book a call than draft a note.
//
// Styling mirrors the ConflictDialog modal (fixed-inset backdrop, rounded-2xl
// white card, font-heading bold heading). a11y additions on top of that
// precedent: role="dialog", aria-modal, aria-labelledby, focus trap, return
// focus to the previously-focused element on close, Escape + backdrop dismiss.
//
// Self-contained focus restoration — captures document.activeElement on open
// rather than asking the parent to pass a trigger ref. The parent only owns
// the open/onClose state.

interface TalkToSalesModalProps {
  open: boolean;
  onClose: () => void;
  /** Fantastical (or other) scheduling URL — opens in a new tab. */
  scheduleUrl: string;
  /** mailto: URL — opens in the user's mail client in the same tab. */
  mailto: string;
}

const TITLE_ID = 'talk-to-sales-title';

export function TalkToSalesModal({ open, onClose, scheduleUrl, mailto }: TalkToSalesModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLAnchorElement | null>(null);
  // Whatever was focused when the modal opened — we restore it on close so
  // keyboard users land back on the trigger button instead of the body root.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
    // Defer to the next frame so the card has actually rendered before we
    // measure its focusable descendants.
    const raf = requestAnimationFrame(() => {
      primaryRef.current?.focus();
    });

    function focusables(): HTMLElement[] {
      if (!cardRef.current) return [];
      return Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      // Restore focus to the trigger so keyboard users don't get dropped on body.
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleBookCall = () => {
    trackCtaClick('pricing_talk_to_sales_book_call');
    // Native <a target="_blank" rel="noopener noreferrer"> handles the actual
    // navigation; this just fires the beacon (keepalive ensures delivery
    // survives the new-tab open).
  };
  const handleEmail = () => {
    trackCtaClick('pricing_talk_to_sales_email');
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      {/* Backdrop click dismisses. Plain <div> rather than a button — the modal
          itself stops propagation, so a click anywhere outside it bubbles here. */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-warm-gray hover:bg-cream hover:text-brown"
        >
          {/* Pure CSS × so we don't pull in an icon dep just for this. */}
          <span aria-hidden="true" className="text-xl leading-none">×</span>
        </button>
        <h3 id={TITLE_ID} className="font-heading font-bold text-lg text-dark-brown mb-2">
          Let's talk
        </h3>
        <p className="text-sm text-warm-gray mb-5">
          Tell us about your organization and we'll get back within a business day, or book 30 minutes with Mark directly.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <a
            ref={primaryRef}
            href={scheduleUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleBookCall}
            className="flex-1 inline-flex items-center justify-center rounded-lg bg-coral px-4 py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#d4603a]"
          >
            Book a 30-min call
          </a>
          <a
            href={mailto}
            onClick={handleEmail}
            className="flex-1 inline-flex items-center justify-center rounded-lg border border-sand bg-cream px-4 py-2.5 text-center font-heading text-sm font-bold text-brown hover:border-coral hover:text-coral"
          >
            Email us instead
          </a>
        </div>
      </div>
    </div>
  );
}
