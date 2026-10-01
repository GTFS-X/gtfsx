import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { FEATURE_COPY, type FeatureKey } from './planConfig';

/**
 * Account gate for features that are free on every plan but need a signed-in
 * account, because each use calls a metered third-party API (the Mapbox
 * Isochrone API behind access isochrones and network walksheds). The server is
 * authoritative: GET /api/mapbox/isochrone answers 401 to anonymous callers.
 * This is the matching client hint, a "Sign in (free)" card rather than an
 * upgrade prompt. Signed-in users (any plan) see the children unchanged.
 */
export function SignInRequired({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const location = useLocation();
  if (currentUser) return <>{children}</>;

  const copy = FEATURE_COPY[feature];
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  return (
    <div className="flex justify-center" data-testid="sign-in-required">
      <div className="m-6 max-w-md rounded-2xl border border-sand bg-white p-6 shadow-lg">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-teal">Free account</div>
        <h3 className="font-heading text-lg font-bold text-dark-brown">{copy.title}</h3>
        <p className="mt-1.5 text-sm text-warm-gray">{copy.description}</p>
        <p className="mt-3 text-sm font-semibold text-dark-brown">
          Sign in (free) to use this. It&rsquo;s free on every plan; an account is needed because each
          analysis calls a metered mapping service.
        </p>
        <div className="mt-4 flex gap-2">
          <AuthButton onClick={() => navigate(`/login?next=${next}`)}>Sign in</AuthButton>
          <AuthButton variant="ghost" onClick={() => navigate(`/signup?next=${next}`)}>
            Create a free account
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

/** Compact inline variant for a single control (the Coverage walkshed toggle). */
export function SignInRequiredLink({ label }: { label: string }) {
  const location = useLocation();
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  return (
    <Link
      to={`/login?next=${next}`}
      data-testid="walkshed-sign-in"
      className="flex w-full items-center gap-2 rounded-lg border border-sand bg-cream px-3 py-2 text-xs font-semibold text-warm-gray transition-colors hover:border-teal hover:text-teal"
      title="Free on every plan. Sign in so we can run the street-network analysis (it calls a metered mapping service)."
    >
      <span aria-hidden>🚶</span>
      <span>{label}</span>
      <span className="ml-auto rounded border border-sand bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal">
        Sign in (free)
      </span>
    </Link>
  );
}
