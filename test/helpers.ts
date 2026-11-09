import { env, exports } from 'cloudflare:workers';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sessionCookie } from '../src/auth';
import { b64url } from '../src/util';

// Every request uses the configured MCP_RESOURCE origin: access tokens are bound to it.
export const ORIGIN = new URL(env.MCP_RESOURCE).origin;
// Real requests always carry Host (the MCP handler validates it); test Requests don't.
function withHost(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('Host', new URL(request.url).host);
  return new Request(request, { headers });
}
export const hub = (path: string, init?: RequestInit) => exports.default.fetch(withHost(new Request(ORIGIN + path, init)));

let users = 0;
export function newUser() {
  users += 1;
  return { uid: `gh-${9000 + users}-${crypto.randomUUID().slice(0, 8)}`, login: `tester${users}` };
}

export async function cookieFor(user: { uid: string; login: string }): Promise<string> {
  const set = await sessionCookie({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 }, ORIGIN, env.COOKIE_ENCRYPTION_KEY);
  return set.split(';')[0];
}

function jar(...responses: Response[]): string {
  return responses.flatMap((r) => r.headers.getSetCookie().map((c) => c.split(';')[0])).join('; ');
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  hub(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Full pairing flow as a user would do it; returns the arm token.
export async function pairArm(cookie: string, kind: string, name: string): Promise<{ token: string; armUrl: string }> {
  const start = (await (await post('/pair/start', { kind, name })).json()) as { code: string; pollToken: string };
  const pageRes = await hub(`/pair?code=${start.code}`, { headers: { Cookie: cookie } });
  const html = await pageRes.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no csrf on the pair page: ${html.slice(0, 300)}`);
  const form = new URLSearchParams({ code: start.code, csrf, decision: 'approve' });
  const approve = await hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  if (approve.status !== 200) throw new Error(`approve: ${approve.status}`);
  const poll = (await (await post('/pair/poll', { code: start.code, pollToken: start.pollToken })).json()) as { armToken: string; armUrl: string };
  return { token: poll.armToken, armUrl: poll.armUrl };
}

// The OAuth 2.1 flow an MCP client runs, with the hub's web session standing in for GitHub.
export async function accessToken(cookie: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:9999/cb';
  const reg = (await (await post('/register', { redirect_uris: [redirectUri], client_name: 'Test client', token_endpoint_auth_method: 'none' })).json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: env.MCP_RESOURCE });
  const consent = await hub(`/authorize?${q}`, { headers: { Cookie: cookie } });
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1];
  if (!handle) throw new Error(`no consent handle (${consent.status})`);
  const approved = await hub('/authorize', {
    method: 'POST',
    headers: { Cookie: `${cookie}; ${jar(consent)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }),
    redirect: 'manual',
  });
  const code = new URL(approved.headers.get('Location') ?? 'http://x/').searchParams.get('code');
  if (!code) throw new Error(`no code: ${approved.status} ${approved.headers.get('Location')}`);
  const tok = await hub('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: env.MCP_RESOURCE }),
  });
  const body = (await tok.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token: ${tok.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

export async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(env.MCP_RESOURCE), {
    fetch: (url, init) => exports.default.fetch(withHost(new Request(url, init))),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'cloud-bridge-test', version: '0' });
  await client.connect(transport);
  return client;
}

type Msg = { id?: string; method?: string; params?: any; result?: any; error?: any };

export interface TestArm {
  ws: WebSocket;
  received: Msg[];
  ready: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

// An arm speaking the protocol over a real hub WebSocket.
export async function connectArm(
  token: string,
  opts: { name: string; kind?: string; tools?: unknown[]; onCall?: (params: any) => unknown | undefined; selector?: string; offlineHint?: string },
): Promise<TestArm> {
  const res = await hub('/arm', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `cloud-bridge.v1, cbtoken.${token}` } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status} ${await res.text()}`);
  ws.accept();
  const received: Msg[] = [];
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.addEventListener('close', (e) => r({ code: e.code, reason: e.reason })));
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') {
      received.push({ method: 'pong' });
      return;
    }
    const msg = JSON.parse(e.data as string) as Msg;
    received.push(msg);
    const send = (data: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data));
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: opts.tools ?? [] } });
      setTimeout(markReady, 20);
    }
    if (msg.method === 'tools/call') {
      const result = opts.onCall?.(msg.params);
      if (result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
    }
  });
  // A refused socket (4401) may already be closed here.
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/hello', params: { kind: opts.kind ?? 'fake', name: opts.name, version: '0.1.0', selector: opts.selector ?? 'arm', offlineHint: opts.offlineHint } }));
  return { ws, received, ready, closed };
}

export const ECHO = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
export const SNAP = { name: 'fake_snap', description: 'Fake snap', inputSchema: { type: 'object', properties: {} } };
