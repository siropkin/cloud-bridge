const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sign(value: string, secret: string): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value)));
}

export async function verify(value: string, mac: string, secret: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(mac), enc.encode(value));
  } catch {
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

// Secure + __Host- on https; plain names on http://localhost dev.
export function cookieName(base: string, url: string): string {
  return url.startsWith('https:') ? `__Host-${base}` : base;
}

export function setCookie(base: string, value: string, url: string, maxAge: number): string {
  const secure = url.startsWith('https:') ? '; Secure' : '';
  return `${cookieName(base, url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

// formRedirects: the form's answer redirects off-site (OAuth consent → the client's
// redirect_uri or GitHub). Chrome applies form-action to those redirects too, so
// such pages can't pin form-action to 'self'.
export function page(title: string, body: string, init: { status?: number; headers?: Headers; formRedirects?: boolean } = {}): Response {
  const headers = init.headers ?? new Headers();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', init.formRedirects ? CSP : `${CSP}; form-action 'self'`);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Cloud Bridge</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}
button{font:inherit;padding:.5rem 1.1rem;border-radius:.4rem;border:1px solid #7c3aed;background:#7c3aed;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#7c3aed}.note{color:#666;font-size:.9rem}code{background:#f3f0ff;padding:.1rem .3rem;border-radius:.2rem}
@media(prefers-color-scheme:dark){body{background:#16131f;color:#eee}button.secondary{background:#16131f}code{background:#2a2340}.note{color:#aaa}}</style>
<h1>🟣 ${escapeHtml(title)}</h1>${body}</html>`;
  return new Response(html, { status: init.status ?? 200, headers });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
