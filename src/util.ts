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

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'";

// formRedirects: the form's answer redirects off-site (OAuth consent → the client's
// redirect_uri or GitHub). Chrome applies form-action to those redirects too, so
// such pages can't pin form-action to 'self'.
// script: one inline script, allowed by its CSP hash (base64 SHA-256, pinned by a test) and nothing else.
// The hub's icon (a purple dot, as the 🟣 in headings). Without one Chrome shows
// a placeholder in the tab (Ivan read it as a clock).
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#7c3aed"/></svg>`;
export function favicon(): Response {
  return new Response(FAVICON, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
}

// icon: the heading's mark — ✅ on pages that say something is done.
export function page(title: string, body: string, init: { status?: number; headers?: Headers; formRedirects?: boolean; script?: { code: string; hash: string }; icon?: string } = {}): Response {
  const headers = init.headers ?? new Headers();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  const scriptSrc = init.script ? `; script-src 'sha256-${init.script.hash}'` : '';
  headers.set('Content-Security-Policy', (init.formRedirects ? CSP : `${CSP}; form-action 'self'`) + scriptSrc);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title === 'Cloud Bridge' ? title : `${title} · Cloud Bridge`)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}
button{font:inherit;padding:.5rem 1.1rem;border-radius:.4rem;border:1px solid #7c3aed;background:#7c3aed;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#7c3aed}.note{color:#666;font-size:.9rem}code{background:#f3f0ff;padding:.1rem .3rem;border-radius:.2rem}
a.button{display:inline-block;text-decoration:none;font-weight:600;padding:.45rem 1rem;border-radius:.4rem;border:1px solid #7c3aed;color:#7c3aed}
.link{display:flex;gap:.5rem;align-items:center;margin:.5rem 0}.link code{user-select:all;word-break:break-all}
section{border:1px solid #ddd6fe;border-radius:.6rem;padding:.2rem 1rem 1rem;margin:1rem 0}ol{padding-left:1.3rem}li{margin:.25rem 0}
.warn{border-left:4px solid #dc2626;background:#fef2f2;padding:.5rem .8rem;border-radius:.3rem}
@media(prefers-color-scheme:dark){body{background:#16131f;color:#eee}button.secondary{background:#16131f}code{background:#2a2340}.note{color:#aaa}a.button{color:#c4b5fd;border-color:#a78bfa}section{border-color:#3b2f5c}.warn{background:#3a1518}}</style>
<h1>${init.icon ?? '🟣'} ${escapeHtml(title)}</h1>${body}${init.script ? `<script>${init.script.code}</script>` : ''}</html>`;
  return new Response(html, { status: init.status ?? 200, headers });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
