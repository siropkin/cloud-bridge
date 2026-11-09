// Downloads a file for an arm that has no business fetching it itself:
// chrome-bridge's cloud upload takes public URLs, and a fetch from the user's
// browser could reach their LAN (router, NAS, the local bridge) — hostname
// checks can't stop a DNS name that points there. From here it can't:
// global_fetch_strictly_public refuses private addresses on every hop. The
// hostname check below only words the obvious cases for the model.
export const DOWNLOAD_MAX = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface Downloaded {
  name: string;
  mimeType: string;
  data: string; // base64
}

export function privateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|home\.arpa)$/.test(h)) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // single-label intranet names
  if (/^(0|10|127)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (!h.includes(':')) return false;
  // IPv6: loopback/unspecified, unique-local, link-local, and IPv4 embedded in
  // it (::a.b.c.d, ::ffff:…, NAT64 64:ff9b::) — the URL parser writes those as hex.
  return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::(ffff:)?[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:');
}

const tooBig = (n: number, max: number) => `the file is over ${(max / 1048576).toFixed(0)} MB${n ? ` (${(n / 1048576).toFixed(1)} MB)` : ''} — Cloud Bridge uploads take up to ${(max / 1048576).toFixed(0)} MB`;

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function downloadPublic(raw: string, fetchImpl: typeof fetch = fetch, max = DOWNLOAD_MAX): Promise<Downloaded> {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`${raw.slice(0, 200)} is not an http(s) URL`);
  if (privateHost(url.hostname)) throw new Error(`${url.host} is a private-network address; Cloud Bridge only downloads upload files from public addresses — send the file as base64 instead`);
  let res: Response;
  try {
    res = await fetchImpl(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'cloud-bridge (file for an upload)' } });
  } catch (error) {
    throw new Error(`couldn't download ${url.href} (${(error as Error).message}) — check that the URL is public, or send the file as base64`);
  }
  const final = new URL(res.url || url.href);
  if (privateHost(final.hostname)) {
    await res.body?.cancel();
    throw new Error(`${url.host} redirected to a private-network address (${final.host}); nothing was uploaded`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`downloading ${url.href} answered ${res.status} — the file must be public (no sign-in), or send it as base64`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(tooBig(declared, max));
  }
  // Counted while it streams: a response without Content-Length (chunked,
  // compressed) must not be held whole before the cap applies.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(tooBig(0, max));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '');
  let name = disposition ? disposition[1] : final.pathname.split('/').pop() || '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep it as sent
  }
  name = name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'download';
  return { name, mimeType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream', data: base64(bytes) };
}
