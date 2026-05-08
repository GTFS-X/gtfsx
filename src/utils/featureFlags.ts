export const backendEnabled: boolean = (() => {
  const v = import.meta.env.VITE_BACKEND_ENABLED;
  return v === 'true' || v === '1' || v === true;
})();

// Cloudflare Turnstile site key (public). Empty string = widget disabled
// (dev fallback). Matching TURNSTILE_SECRET_KEY lives as a Worker secret.
export const turnstileSiteKey: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';
