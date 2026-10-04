// Download a catalog (Mobility Database) feed ZIP through the hardened
// /api/import/fetch endpoint — the same path as "Import from URL": SSRF checks
// on every redirect hop, a streamed size cap, a ZIP magic-byte check, and no
// caching. Returns the ZIP bytes as a Blob, or throws an Error carrying the
// server's user-facing message.

export async function downloadFeedZipViaImportApi(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  const res = await fetchImpl(`/api/import/fetch?url=${encodeURIComponent(url)}`, {
    method: 'GET',
    headers: { 'X-GB-Client': 'web' },
    credentials: 'omit',
  });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try {
        const payload = (await res.json()) as { message?: string };
        if (payload?.message) message = payload.message;
      } catch {
        // keep the default message
      }
    }
    throw new Error(message);
  }
  return res.blob();
}
