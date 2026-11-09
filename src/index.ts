import { env } from 'cloudflare:workers';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { authorize, callback, login, logout, type HubEnv } from './auth';
import { armTokenUser, ARM_PROTOCOL, refuse } from './hub';
import { mcpHandler } from './mcp';
import { pairApprove, pairPage, pairPoll, pairStart } from './pair';
import { escapeHtml, page } from './util';

export { UserHub } from './hub';

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

async function route(request: Request, env: HubEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const m = request.method;
  if (pathname === '/authorize' && (m === 'GET' || m === 'POST')) return authorize(request, env);
  if (pathname === '/callback' && m === 'GET') return callback(request, env);
  if (pathname === '/login' && m === 'GET') return login(request, env);
  if (pathname === '/logout' && m === 'POST') return logout(request);
  if (pathname === '/pair' && m === 'GET') return pairPage(request, env);
  if (pathname === '/pair/start' && m === 'POST') return pairStart(request, env);
  if (pathname === '/pair/poll' && m === 'POST') return pairPoll(request, env);
  if (pathname === '/pair/approve' && m === 'POST') return pairApprove(request, env);
  if (pathname === '/arm') return arm(request, env);
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

export default new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: { fetch: mcpHandler as unknown as ExportedHandlerFetchHandler<Env> },
  defaultHandler: webHandler as unknown as ExportedHandler<Env>,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  resourceMetadata: { resource: env.MCP_RESOURCE },
});
