import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { armLabel, kindName } from './kinds';
import { b64url, cookies, escapeHtml, page, randomToken, setCookie, sha256, sign, verify, cookieName } from './util';

export type HubEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

// What every MCP request knows about its user (encrypted into the access token).
export interface Props extends Record<string, unknown> {
  userId: string; // "gh-<numeric GitHub id>": stable across renames (the OAuth library forbids ":")
  login: string;
}

export interface Session {
  uid: string;
  login: string;
  exp: number;
}

const SESSION = 'cb_session';
const SESSION_TTL = 7 * 24 * 3600;
const LOGIN_STATE = 'cb_login';

export async function sessionCookie(s: Session, url: string, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(s)));
  return setCookie(SESSION, `${body}.${await sign(body, secret)}`, url, Math.max(0, s.exp - Math.floor(Date.now() / 1000)));
}

export async function readSession(request: Request, secret: string): Promise<Session | null> {
  const raw = cookies(request).get(cookieName(SESSION, request.url));
  const [body, mac] = raw?.split('.') ?? [];
  if (!body || !mac || !(await verify(body, mac, secret))) return null;
  try {
    const s = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

// Same-origin path only. Prefix checks aren't enough: the URL parser drops tabs and
// newlines, so "/\t/evil.com" resolves to https://evil.com/. And /callback resolves
// the result again: dot segments ("/.//evil.com", "/a/..//evil.com") normalize to a
// path "//evil.com", which that second parse reads as a host (S1).
export function safeNext(next: string | null, requestUrl: string): string {
  if (!next?.startsWith('/')) return '/';
  try {
    const origin = new URL(requestUrl).origin;
    const u = new URL(next, origin);
    return u.origin === origin && !u.pathname.startsWith('//') ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}

async function githubAuthorizeUrl(env: Env, request: Request, state: string, verifier: string): Promise<string> {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', await sha256(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('allow_signup', 'true');
  return u.href;
}

async function githubUser(env: Env, request: Request, code: string, verifier: string): Promise<Props> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL('/callback', request.url).href,
      code_verifier: verifier,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`GitHub refused the sign-in code (${token.error ?? tokenRes.status})`);
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'cloud-bridge', Accept: 'application/vnd.github+json' },
  });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed (${userRes.status})`);
  const user = (await userRes.json()) as { id: number; login: string };
  // The token is used once, here; the hub never calls GitHub for the user again.
  return { userId: `gh-${user.id}`, login: user.login };
}

// GET /login?next=/pair?code=… — the hub's own web sign-in (pairing, later the UI).
export async function login(request: Request, env: Env): Promise<Response> {
  const next = safeNext(new URL(request.url).searchParams.get('next'), request.url);
  const id = randomToken(16);
  const verifier = randomToken(32);
  await env.OAUTH_KV.put(`weblogin:${await sha256(id)}`, JSON.stringify({ next, verifier }), { expirationTtl: 600 });
  const headers = new Headers({ Location: await githubAuthorizeUrl(env, request, `w.${id}`, verifier) });
  headers.append('Set-Cookie', setCookie(LOGIN_STATE, id, request.url, 600));
  return new Response(null, { status: 302, headers });
}

// Only from the hub's own pages: another site's form POST would act with the
// person's cookie (a response's Set-Cookie applies whatever SameSite says) (S1).
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  return !((site && site !== 'same-origin' && site !== 'none') || (origin && origin !== new URL(request.url).origin));
}

export function clearSession(url: string): string {
  return setCookie(SESSION, '', url, 0);
}

// POST only: a GET sign-out could be triggered by any page's <img>. And only from
// the hub's own pages: another site's form POST cleared the cookie too (S1).
export function logout(request: Request): Response {
  if (!sameOrigin(request)) {
    return page('Still signed in', "<p>Signing out works from Cloud Bridge's own pages only, so nothing changed.</p>", { status: 403 });
  }
  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', clearSession(request.url));
  return new Response(null, { status: 303, headers });
}

export async function requireSession(request: Request, env: Env): Promise<Session | Response> {
  const s = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (s) return s;
  const u = new URL(request.url);
  return Response.redirect(new URL(`/login?next=${encodeURIComponent(u.pathname + u.search)}`, u).href, 302);
}

type ArmSummary = { kind: string; name: string; online: boolean };

// Self-registered apps name themselves: one called "Claude" that sent access to
// claude.ai.evil.example got the same page as Claude, on the real hub's address
// (S1). These vendors' web apps return to their own domains; an app on this
// computer (loopback, or a custom scheme like claude://) keeps access here.
const VENDORS = [
  { name: /claude|anthropic/i, label: 'Claude', domains: ['claude.ai', 'claude.com', 'anthropic.com'] },
  { name: /chat\s*gpt|openai/i, label: 'ChatGPT', domains: ['chatgpt.com', 'openai.com'] },
];
export function impostor(details: { clientName: string; clientDomain?: string; redirectUri: string; redirectIsLoopback: boolean }): { label: string; home: string; host: string } | null {
  if (details.redirectIsLoopback) return null;
  let host: string;
  try {
    const u = new URL(details.redirectUri);
    if (u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  const vendor = VENDORS.find((v) => v.name.test(details.clientName));
  if (!vendor) return null;
  const at = (h: string) => vendor.domains.some((d) => h === d || h.endsWith(`.${d}`));
  if (at(host) && (!details.clientDomain || at(details.clientDomain.toLowerCase()))) return null;
  return { label: vendor.label, home: vendor.domains[0], host };
}

// People's words: what the app gets ("your Chrome"), which profiles, and where access goes.
function consentPage(details: Awaited<ReturnType<OAuthHelpers['describeConsent']>>, handle: string, session: Session | null, arms: ArmSummary[], headers: Headers): Response {
  const name = escapeHtml(details.clientName);
  const fake = impostor(details);
  const kinds = [...new Set(arms.map((a) => kindName(a.kind)))];
  const what = kinds.length ? kinds.join(' and ') : 'Chrome';
  const has = arms.length
    ? `<p>It will be able to use ${arms.map((a) => `<strong>${escapeHtml(armLabel(a.kind, a.name))}</strong>`).join(', ')}: read and use your tabs, as you, in the accounts you're signed in to.</p>`
    : session
      ? "<p>It will be able to use the Chrome profiles you connect to Cloud Bridge: read and use your tabs, as you, in the accounts you're signed in to. None is connected yet: connect one from the chrome-bridge popup (⚙ Settings → Cloud AI apps).</p>"
      : "<p>It will be able to use the Chrome profiles you connect to Cloud Bridge: read and use your tabs, as you, in the accounts you're signed in to.</p>";
  const origin = details.clientDomain ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>. ` : '';
  const who = session ? `You're signed in as <strong>@${escapeHtml(session.login)}</strong>.` : 'Next you sign in with GitHub.';
  const warning = fake
    ? `<p class="warn"><strong>Careful: this may not be ${fake.label}.</strong> It calls itself ${name}, but ${fake.label} sends you back to ${fake.home}, and this app sends access to <strong>${escapeHtml(fake.host)}</strong>. Click Deny unless you set this app up yourself.</p>\n`
    : '';
  const [allow, deny] = fake ? ['secondary', ''] : ['', 'secondary'];
  return page(
    fake ? `Allow an app calling itself ${details.clientName} to use your ${what}?` : `Allow ${details.clientName} to use your ${what}?`,
    `${warning}${has}
<p>${origin}Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>. Continue only if you're adding Cloud Bridge in ${name} right now.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting it.</p>' : ''}
<p>${who}</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><button${allow ? ` class="${allow}"` : ''} name="decision" value="approve">Allow</button> <button${deny ? ` class="${deny}"` : ''} name="decision" value="deny">Deny</button></p></form>`,
    { headers, formRedirects: true },
  );
}

function authError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError) return page('Sign-in stopped', `<p>${escapeHtml(error.description ?? error.message)}</p><p>Start connecting again from your AI app.</p>`, { status: 400 });
  if (error instanceof CimdFetchError) return page('Sign-in stopped', '<p>This app could not be verified. Start connecting again from your AI app.</p>', { status: 400 });
  throw error;
}

// GET/POST /authorize — an MCP client (Claude, ChatGPT…) asks for access.
export async function authorize(request: Request, env: HubEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const arms = session ? await env.USER_HUB.get(env.USER_HUB.idFromName(session.uid)).armSummary() : [];
      return consentPage(details, consent.handle, session, arms, consent.headers);
    }
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set('Location', denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    if (session) return complete(oauth, approved.request, { userId: session.uid, login: session.login }, approved.headers);
    const verifier = randomToken(32);
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    headers.set('Location', await githubAuthorizeUrl(env, request, state, verifier));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authError(error);
  }
}

async function complete(oauth: OAuthHelpers, authRequest: AuthRequest, props: Props, headers: Headers): Promise<Response> {
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: props.userId,
    metadata: { login: props.login },
    scope: authRequest.scope,
    props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

// GET /callback — GitHub sends the user back, for a web login ("w." state) or an MCP authorization.
export async function callback(request: Request, env: HubEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  if (state.startsWith('w.')) {
    const id = state.slice(2);
    const key = `weblogin:${await sha256(id)}`;
    const saved = await env.OAUTH_KV.get<{ next: string; verifier: string }>(key, 'json');
    if (!saved || cookies(request).get(cookieName(LOGIN_STATE, request.url)) !== id) {
      return page('Sign-in expired', '<p>This sign-in link expired or was opened in another browser. <a href="/login">Sign in again</a>.</p>', { status: 400 });
    }
    await env.OAUTH_KV.delete(key);
    if (!code) return page('Sign-in cancelled', `<p>GitHub didn't sign you in. <a href="/login?next=${encodeURIComponent(saved.next)}">Try again</a>.</p>`, { status: 400 });
    const props = await githubUser(env, request, code, saved.verifier);
    const headers = new Headers({ Location: new URL(saved.next, url).href });
    headers.append('Set-Cookie', await sessionCookie({ uid: props.userId, login: props.login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, request.url, env.COOKIE_ENCRYPTION_KEY));
    headers.append('Set-Cookie', setCookie(LOGIN_STATE, '', request.url, 0));
    return new Response(null, { status: 302, headers });
  }
  try {
    const { request: original, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
    if (!code) {
      headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
      return new Response(null, { status: 302, headers });
    }
    const props = await githubUser(env, request, code, data.verifier);
    headers.append('Set-Cookie', await sessionCookie({ uid: props.userId, login: props.login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, request.url, env.COOKIE_ENCRYPTION_KEY));
    return complete(env.OAUTH_PROVIDER, original, props, headers);
  } catch (error) {
    return authError(error);
  }
}
