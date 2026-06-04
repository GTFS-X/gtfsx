import { useMemo } from 'react';

interface GoogleSignInButtonProps {
  /** "Continue with Google" (default) or a custom label, e.g. "Sign up with Google". */
  label?: string;
  /**
   * Same-origin relative path to land on after a successful sign-in. Threaded
   * through to /auth/google/start as ?next so it survives the OAuth round-trip.
   * Only honored if it's a relative path starting with "/".
   */
  next?: string | null;
}

// The Google "G" mark (official four-color logo), inline so it ships without a
// network fetch and renders crisp at any size.
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2823-1.1168-.2823-1.71s.1023-1.17.2823-1.71V4.9582H.9574C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9574 4.0418L3.964 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9574 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}

export function GoogleSignInButton({ label = 'Continue with Google', next }: GoogleSignInButtonProps) {
  const href = useMemo(() => {
    const base = '/auth/google/start';
    if (next && next.startsWith('/')) {
      return `${base}?next=${encodeURIComponent(next)}`;
    }
    return base;
  }, [next]);

  // Full-page navigation (not fetch): the OAuth redirect flow needs a real
  // top-level navigation so the browser follows Google's 302s and stores the
  // session cookie on return. A plain <a> does exactly that.
  return (
    <a
      href={href}
      className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-lg font-heading font-bold text-sm border border-sand bg-white text-dark-brown hover:bg-cream transition-colors"
    >
      <GoogleG />
      {label}
    </a>
  );
}

// A labeled divider ("or") to separate the OAuth button from the email form.
export function AuthDivider({ label = 'or' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 my-5" role="separator" aria-label={label}>
      <div className="flex-1 h-px bg-sand" />
      <span className="text-xs uppercase tracking-wide text-warm-gray">{label}</span>
      <div className="flex-1 h-px bg-sand" />
    </div>
  );
}
