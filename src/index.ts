import { env } from 'cloudflare:workers';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { authorize, callback, login, logout, requireSession, type HubEnv } from './auth';
import { fileResponse } from './files';
import { armTokenUser, ARM_PROTOCOL, refuse } from './hub';
import { addPage, homePage } from './guide';
import { limitAnonymous } from './limits';
import { mcpHandler } from './mcp';
import { pairApprove, pairPage, pairPoll, pairStart } from './pair';
import { oauthKv } from './store';
import { escapeHtml, favicon, json, page } from './util';

export { UserHub } from './hub';
export { OAuthStore } from './store';

// /arm: the arm's outbound WebSocket. Browsers can't set headers on a WebSocket,
// so the token rides as a subprotocol ("cbtoken.<token>"); Node arms may use Authorization.
async function arm(request: Request, env: HubEnv): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(`Connect with a WebSocket (subprotocols "${ARM_PROTOCOL}", "cbtoken.<armToken>").`, { status: 426 });
  }
  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
  const token = offered.find((p) => p.startsWith('cbtoken.'))?.slice(8) ?? request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const userId = armTokenUser(token);
  if (!userId) return refuse(request, 'missing or malformed arm token: pair this arm again');
  const headers = new Headers(request.headers);
  headers.set('x-arm-token', token);
  headers.delete('Authorization');
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId)).fetch(new Request(request.url, { headers }));
}

// POST /arm/revoke (Authorization: Bearer <armToken>): the arm signs itself out
// (Cloud AI apps switched off, extension removed) and AI apps stop seeing it.
// Answers ok for an unknown token too: signing out twice is not an error.
async function revoke(request: Request, env: HubEnv): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const userId = armTokenUser(token);
  if (!userId) return json({ ok: false, error: 'invalid_token', message: 'Send the arm token as "Authorization: Bearer cba_…".' }, 401);
  const revoked = await env.USER_HUB.get(env.USER_HUB.idFromName(userId)).revokeArm(token);
  return json({ ok: true, revoked });
}

// GET /files/<id>/<name>: a file an arm saved (fetch --out, net --har). It can
// hold cookies and tokens, so the link opens only after sign-in, for the account
// that made it; anyone else gets the same "expired" page as a stale link.
async function file(request: Request, env: HubEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const found = await env.USER_HUB.get(env.USER_HUB.idFromName(session.uid)).readFile(session.uid, id);
  if (found) return fileResponse(found.bytes, found.meta);
  return page(
    'This download link has expired',
    `<p>Files from Cloud Bridge last an hour and open only for the GitHub account that made them (you're signed in as <strong>@${escapeHtml(session.login)}</strong>).</p><p>Ask your AI app to run the command again for a new link.</p>`,
    { status: 404 },
  );
}

async function route(request: Request, env: HubEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const m = request.method;
  if (pathname === '/' && m === 'GET') return homePage(request);
  if (pathname === '/add' && m === 'GET') return addPage(request);
  if ((pathname === '/favicon.svg' || pathname === '/favicon.ico') && m === 'GET') return favicon();
  if (pathname === '/authorize' && (m === 'GET' || m === 'POST')) return authorize(request, env);
  if (pathname === '/callback' && m === 'GET') return callback(request, env);
  if (pathname === '/login' && m === 'GET') return login(request, env);
  if (pathname === '/logout' && m === 'POST') return logout(request);
  if (pathname === '/pair' && m === 'GET') return pairPage(request, env);
  if (pathname === '/pair/start' && m === 'POST') return pairStart(request, env);
  if (pathname === '/pair/poll' && m === 'POST') return pairPoll(request, env);
  if (pathname === '/pair/approve' && m === 'POST') return pairApprove(request, env);
  if (pathname === '/arm/revoke' && m === 'POST') return revoke(request, env);
  if (pathname === '/arm') return arm(request, env);
  const f = /^\/files\/([^/]+)\/[^/]*$/.exec(pathname);
  if (f && m === 'GET') return file(request, env, f[1]);
  return new Response('Not found', { status: 404 });
}

const webHandler = {
  async fetch(request: Request, env: HubEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('hub error', request.method, new URL(request.url).pathname, error);
      return page('Something went wrong', `<p>${escapeHtml((error as Error).message)}</p><p>Go back and try again.</p>`, { status: 500 });
    }
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: { fetch: mcpHandler as unknown as ExportedHandlerFetchHandler<Env> },
  defaultHandler: webHandler as unknown as ExportedHandler<Env>,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  resourceMetadata: { resource: env.MCP_RESOURCE },
});

// Everything below the provider (the OAuth library, pairing, web sign-in) sees
// OAUTH_KV as the Durable Object store: free KV takes only 1,000 writes a day for
// the whole account, and anonymous requests used to spend them (src/store.ts).
// Files reach the real KV through UserHub's own env. Per-network limits come
// first, so a flood on /register never reaches the library's storage.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await limitAnonymous(request, env);
    if (limited) return limited;
    return provider.fetch(request, { ...env, OAUTH_KV: oauthKv(env) }, ctx);
  },
} satisfies ExportedHandler<Env>;
