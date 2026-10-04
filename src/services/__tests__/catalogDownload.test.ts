import { describe, expect, it, vi } from 'vitest';
import { downloadFeedZipViaImportApi } from '../catalogDownload';

describe('downloadFeedZipViaImportApi', () => {
  it('downloads through /api/import/fetch (never the removed /_import/proxy)', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200 }));
    const blob = await downloadFeedZipViaImportApi(
      'https://files.mobilitydatabase.org/mdb-1/latest.zip',
      fetchImpl as unknown as typeof fetch,
    );
    expect(blob.size).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(
      `/api/import/fetch?url=${encodeURIComponent('https://files.mobilitydatabase.org/mdb-1/latest.zip')}`,
    );
    expect(path).not.toContain('_import/proxy');
    expect((init.headers as Record<string, string>)['X-GB-Client']).toBe('web');
    expect(init.credentials).toBe('omit');
  });

  it('surfaces the server message on failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'too_large', message: 'This feed is too big.' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      downloadFeedZipViaImportApi('https://x.example/feed.zip', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('This feed is too big.');
  });
});
