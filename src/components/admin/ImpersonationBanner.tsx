import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { endImpersonation, STAFF_IMPERSONATOR_KEY } from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

export function ImpersonationBanner() {
  const currentUser = useStore((s) => s.currentUser);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!currentUser) return null;
  const staffId =
    typeof localStorage !== 'undefined' ? localStorage.getItem(STAFF_IMPERSONATOR_KEY) : null;
  if (!staffId || staffId === currentUser.id) return null;

  const exit = async () => {
    setBusy(true);
    setError(null);
    try {
      await endImpersonation();
      localStorage.removeItem(STAFF_IMPERSONATOR_KEY);
      await hydrateAuth();
      navigate('/admin');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not exit impersonation';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-red-600 text-white border-b border-red-700 shrink-0">
      <div className="px-4 py-2 flex items-center gap-3 text-sm">
        <span className="px-2 py-0.5 rounded bg-white/20 text-[10px] font-bold uppercase tracking-wide">
          Impersonating
        </span>
        <span className="flex-1">
          You are viewing as <span className="font-semibold">{currentUser.email}</span>.
          Actions will be attributed to this user.
        </span>
        {error && <span className="text-xs text-red-100">{error}</span>}
        <button
          onClick={exit}
          disabled={busy}
          className="px-3 py-1 rounded-md bg-white text-red-700 font-heading font-bold text-xs hover:bg-red-50 transition-colors disabled:opacity-60"
        >
          {busy ? 'Exiting…' : 'Exit impersonation'}
        </button>
      </div>
    </div>
  );
}
