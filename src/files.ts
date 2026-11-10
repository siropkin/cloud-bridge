// Files an arm made for the user (chrome-bridge's `fetch --out`, `net --har`):
// the hub keeps them in KV for an hour and hands back a download link. A HAR
// from a signed-in tab carries cookies and tokens, so a link is not a bearer
// secret: it opens only for the hub account that made it (sign-in first), and
// the AI app reads it through its own signed-in MCP connection (resources/read).
// Keys carry the user id, so another account's id can't be guessed into.
import { randomToken } from './util';

export const FILE_TTL_S = 3600;
export const FILE_MAX = 10 * 1024 * 1024;
// Per user and day; KV writes are a shared free-tier budget (1,000/day per account).
export const FILES_PER_DAY = 50;

export interface FileMeta {
  name: string;
  mimeType: string;
  size: number;
  expires: number; // ms
}

export interface StoredFile extends FileMeta {
  url: string;
}

const ID = /^[A-Za-z0-9_-]{32}$/;
const key = (userId: string, id: string) => `file:${userId}:${id}`;

export function safeName(raw: unknown): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[\x00-\x1f\x7f"]/g, '_').trim().slice(0, 120) || 'download';
}

// The link's path: /files/<id>/<name> (the name is for the person and the browser's save dialog).
export function fileUrl(origin: string, id: string, name: string): string {
  return `${origin}/files/${id}/${encodeURIComponent(name)}`;
}

export function parseFileUrl(raw: string, origin: string): string | null {
  try {
    const u = new URL(raw);
    const m = /^\/files\/([^/]+)\/[^/]*$/.exec(u.pathname);
    return u.origin === origin && m && ID.test(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

export async function putFile(kv: KVNamespace, userId: string, origin: string, name: string, mimeType: string, bytes: Uint8Array, now = Date.now()): Promise<StoredFile> {
  const id = randomToken(24);
  const meta: FileMeta = { name, mimeType, size: bytes.length, expires: now + FILE_TTL_S * 1000 };
  await kv.put(key(userId, id), bytes, { expirationTtl: FILE_TTL_S, metadata: meta });
  return { ...meta, url: fileUrl(origin, id, name) };
}

export async function getFile(kv: KVNamespace, userId: string, id: string): Promise<{ bytes: ArrayBuffer; meta: FileMeta } | null> {
  if (!ID.test(id)) return null;
  const got = await kv.getWithMetadata<FileMeta>(key(userId, id), 'arrayBuffer');
  if (!got.value || !got.metadata || got.metadata.expires < Date.now()) return null;
  return { bytes: got.value, meta: got.metadata };
}

// Text a model can read as text; anything else goes back as a base64 blob.
export function isText(mimeType: string): boolean {
  return /^text\/|[/+](json|xml)$|^application\/(javascript|x-ndjson)$/i.test(mimeType);
}

// The download itself: always an attachment, never rendered on the hub's origin
// (a fetched HTML page served inline here would run as the hub, next to its cookies).
export function fileResponse(bytes: ArrayBuffer, meta: FileMeta): Response {
  const ascii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return new Response(bytes, {
    headers: {
      'Content-Type': meta.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
