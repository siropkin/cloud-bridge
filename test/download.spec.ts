import { describe, expect, it } from 'vitest';
import { downloadPublic, privateHost } from '../src/download';

const respond = (body: BodyInit | null, init: ResponseInit & { url?: string } = {}) => {
  const res = new Response(body, init);
  Object.defineProperty(res, 'url', { value: init.url ?? '' });
  return res;
};

describe('privateHost', () => {
  it('refuses private, loopback and intranet hosts in every spelling the URL parser leaves', () => {
    for (const u of ['http://localhost/', 'http://localhost./', 'http://router./', 'http://nas.local./', 'http://intranet/', 'http://127.0.0.1/', 'http://0x7f.1/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::127.0.0.1]/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://printer.home.arpa/'])
      expect(privateHost(new URL(u).hostname), u).toBe(true);
    for (const u of ['https://example.com/', 'https://raw.githubusercontent.com/x', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://[2606:4700::1111]/'])
      expect(privateHost(new URL(u).hostname), u).toBe(false);
  });
});

describe('downloadPublic', () => {
  it('returns the bytes as base64 with the file name and type', async () => {
    const fetchImpl = (async () => respond('%PDF', { headers: { 'content-type': 'application/pdf; x=1' }, url: 'https://files.test/docs/report%201.pdf' })) as unknown as typeof fetch;
    expect(await downloadPublic('https://files.test/docs/report%201.pdf', fetchImpl)).toEqual({ name: 'report 1.pdf', mimeType: 'application/pdf', data: 'JVBERg==' });
    const named = (async () => respond('x', { headers: { 'content-disposition': 'attachment; filename="a/b.txt"' }, url: 'https://files.test/dl?id=1' })) as unknown as typeof fetch;
    expect(await downloadPublic('https://files.test/dl?id=1', named)).toMatchObject({ name: 'a_b.txt', mimeType: 'text/plain' });
  });
  it('refuses before fetching: not http(s), or a private host', async () => {
    let fetched = 0;
    const fetchImpl = (async () => (fetched++, respond('x'))) as unknown as typeof fetch;
    await expect(downloadPublic('/Users/me/a.png', fetchImpl)).rejects.toThrow('/Users/me/a.png is not an http(s) URL');
    await expect(downloadPublic('file:///etc/passwd', fetchImpl)).rejects.toThrow('is not an http(s) URL');
    await expect(downloadPublic('http://localhost.:9333/health', fetchImpl)).rejects.toThrow('localhost.:9333 is a private-network address; Cloud Bridge only downloads upload files from public addresses');
    expect(fetched).toBe(0);
  });
  it('refuses a redirect into a private network, a failed status and an oversized body', async () => {
    const redirect = (async () => respond('secret', { url: 'http://192.168.1.1/admin' })) as unknown as typeof fetch;
    await expect(downloadPublic('https://files.test/r', redirect)).rejects.toThrow('files.test redirected to a private-network address (192.168.1.1); nothing was uploaded');
    const gone = (async () => respond('no', { status: 404, url: 'https://files.test/x' })) as unknown as typeof fetch;
    await expect(downloadPublic('https://files.test/x', gone)).rejects.toThrow('answered 404 — the file must be public');
    const declared = (async () => respond('x', { headers: { 'content-length': String(11 * 1048576) } })) as unknown as typeof fetch;
    await expect(downloadPublic('https://files.test/big', declared)).rejects.toThrow('(11.0 MB) — Cloud Bridge uploads take up to 10 MB');
    // No Content-Length: the cap applies while it streams, and the stream is cancelled.
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(400)); }, cancel: () => { cancelled = true; } });
    const endless = (async () => respond(stream, { url: 'https://files.test/stream' })) as unknown as typeof fetch;
    await expect(downloadPublic('https://files.test/stream', endless, 1000)).rejects.toThrow('over 0 MB');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
});
