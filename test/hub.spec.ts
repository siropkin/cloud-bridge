import chromeTools from '../src/chrome-tools.json';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { safeNext } from '../src/auth';
import { oauthKv } from '../src/store';
import type { UserHub } from '../src/hub';
import { describe, expect, it } from 'vitest';
import { COPY_SCRIPT } from '../src/guide';
import { accessToken, connectArm, cookieFor, ECHO, hub, mcpClient, newUser, ORIGIN, pairArm, SNAP } from './helpers';

// What a hub with no Chrome paired lists (synced from chrome-bridge).
const CHROME = chromeTools.map((t) => t.name);

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('auth surface', () => {
  it('runs on the fake test secrets, never the developer\'s .dev.vars', () => {
    expect(env.GITHUB_CLIENT_ID).toBe('test-client-id');
    expect(env.COOKIE_ENCRYPTION_KEY).toMatch(/^test-cookie-key-/);
  });
  it('/mcp without a token is 401 and points at the resource metadata', async () => {
    const res = await hub('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const meta = (await (await hub('/.well-known/oauth-protected-resource/mcp')).json()) as { resource: string };
    expect(meta.resource).toBe(env.MCP_RESOURCE);
  });
  it('/login sends the browser to GitHub with PKCE and a browser-bound state', async () => {
    const res = await hub('/login?next=/pair?code=ABCD-EFGH', { redirect: 'manual' });
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:8787/callback');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('state')).toMatch(/^w\./);
    expect(res.headers.getSetCookie().join()).toContain('cb_login=');
  });
  it('POST /logout clears the session cookie', async () => {
    const res = await hub('/logout', { method: 'POST', headers: { Cookie: await cookieFor(newUser()) }, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().join()).toMatch(/cb_session=; .*Max-Age=0/);
  });
  it('another site cannot sign you out with a form post (S1)', async () => {
    const cookie = await cookieFor(newUser());
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'same-site', Origin: 'https://other.workers.dev' }] as Record<string, string>[]) {
      const res = await hub('/logout', { method: 'POST', headers: { Cookie: cookie, ...headers }, redirect: 'manual' });
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const own = await hub('/logout', { method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN }, redirect: 'manual' });
    expect(own.status).toBe(303);
  });
  it('without a session, an approved MCP consent goes to GitHub with a browser-bound state', async () => {
    const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/cb'], client_name: 'Upstream', token_endpoint_auth_method: 'none' }) })).json()) as any;
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
    const consent = await hub(`/authorize?${q}`);
    const html = await consent.text();
    expect(html).toContain('Next you sign in with GitHub.');
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    const jar = consent.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await hub('/authorize', { method: 'POST', headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }), redirect: 'manual' });
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('state')).not.toMatch(/^w\./);
    // GitHub coming back with an error answers the client with access_denied.
    const back = await hub(`/callback?state=${loc.searchParams.get('state')}&error=access_denied`, { headers: { Cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }, redirect: 'manual' });
    expect(back.headers.get('Location')).toMatch(/^http:\/\/127\.0\.0\.1:9999\/cb\?error=access_denied/);
  });
  it('sign-in only ever returns to a same-origin path', () => {
    const at = 'http://localhost:8787/login';
    expect(safeNext('/pair?code=ABCD-EFGH', at)).toBe('/pair?code=ABCD-EFGH');
    // Tabs/newlines are dropped by the URL parser: these resolved to https://evil.com/ (review finding).
    for (const bad of ['/\t/evil.com/x', '/\n/evil.com', '//evil.com', '/\\evil.com', 'https://evil.com', null]) expect(safeNext(bad, at)).toBe('/');
    // Dot segments normalize to a "//evil.com" path, which /callback resolved as a host (S1).
    for (const bad of ['/.//evil.com', '/./\\evil.com', '/a/..//evil.com', '/%2e//evil.com', '/..//evil.com/x?y=1']) {
      const next = safeNext(bad, at);
      expect(new URL(next, 'http://localhost:8787/callback').origin).toBe('http://localhost:8787');
    }
  });
  it('a web-login callback without the state cookie is refused', async () => {
    const res = await hub('/login?next=/', { redirect: 'manual' });
    const state = new URL(res.headers.get('Location')!).searchParams.get('state');
    const cb = await hub(`/callback?state=${state}&code=x`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain('opened in another browser');
  });
  it('the MCP consent page lets its form redirect off-site and refuses a forged post', async () => {
    const cookie = await cookieFor(newUser());
    const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/cb'], client_name: 'CSP check', token_endpoint_auth_method: 'none' }) })).json()) as any;
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
    const consent = await hub(`/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(await consent.text()).toContain('Allow CSP check to use your Chrome?');
    // Chrome applies form-action to the redirect after the submit: 'self' blocked the
    // 302 to the client's redirect_uri (found live with a scripted MCP client).
    expect(consent.headers.get('Content-Security-Policy')).not.toContain('form-action');
    expect(consent.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const forged = await hub('/authorize', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'handle=nope&decision=approve' });
    expect(forged.status).toBe(400);
  });
});

describe('pairing', () => {
  it('sends a signed-out user to /login first', async () => {
    const res = await hub('/pair?code=ABCD-EFGH', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:8787/login?next=%2Fpair%3Fcode%3DABCD-EFGH');
  });
  it('validates the arm description', async () => {
    const res = await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'Chrome!', name: 'x' }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toContain('Send {"kind":"chrome"');
  });
  it('pending → approved once → expired; the token works once polled', async () => {
    const cookie = await cookieFor(newUser());
    const start = (await (await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'fake', name: 'birch' }) })).json()) as any;
    expect(start.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const poll = () => hub('/pair/poll', { method: 'POST', body: JSON.stringify({ code: start.code, pollToken: start.pollToken }) });
    expect(((await (await poll()).json()) as any).status).toBe('pending');
    const wrong = await hub('/pair/poll', { method: 'POST', body: JSON.stringify({ code: start.code, pollToken: 'x'.repeat(43) }) });
    expect(wrong.status).toBe(404);
    const html = await (await hub(`/pair?code=${start.code.toLowerCase().replace('-', '')}`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Connect Fake “birch”?'); // the kind as people read it (was "Connect chrome …")
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const other = await cookieFor(newUser());
    const stolen = await hub('/pair/approve', { method: 'POST', headers: { Cookie: other, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.code, csrf, decision: 'approve' }) });
    expect(stolen.status).toBe(403);
    await hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.code, csrf, decision: 'approve' }) });
    const done = (await (await poll()).json()) as any;
    expect(done).toMatchObject({ status: 'approved', armUrl: 'ws://localhost:8787/arm' });
    expect(done.armToken).toMatch(/^cba_/);
    expect((await poll()).status).toBe(404);
  });
  it('a double-clicked Connect makes one record, and both clicks see it connected (S1: the second record stayed offline for good)', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const start = (await (await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'fake', name: 'birch' }) })).json()) as any;
    const html = await (await hub(`/pair?code=${start.code}`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const click = () => hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.code, csrf, decision: 'approve' }) });
    const answers = await Promise.all([click(), click(), click()]);
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(await a.text()).toContain('Fake “birch” is connected');
    }
    expect(await env.USER_HUB.get(env.USER_HUB.idFromName(user.uid)).armSummary()).toHaveLength(1);
    const poll = (await (await hub('/pair/poll', { method: 'POST', body: JSON.stringify({ code: start.code, pollToken: start.pollToken }) })).json()) as any;
    const arm = await connectArm(poll.armToken, { name: 'birch', tools: [ECHO] });
    await arm.ready;
    arm.ws.close();
  });
  it('a denied pairing tells the arm', async () => {
    const cookie = await cookieFor(newUser());
    const start = (await (await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'fake', name: 'oak' }) })).json()) as any;
    const html = await (await hub(`/pair?code=${start.code}`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    await hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.code, csrf, decision: 'deny' }) });
    const res = await hub('/pair/poll', { method: 'POST', body: JSON.stringify({ code: start.code, pollToken: start.pollToken }) });
    expect(res.status).toBe(403);
  });
});

describe('pairing anti-phishing (S2c)', () => {
  const SEATTLE = { city: 'Seattle', region: 'Washington', country: 'US' };
  const LAGOS = { city: 'Lagos', region: 'Lagos', country: 'NG' };
  const start = async (cf?: object) => (await (await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'chrome', name: 'birch' }), ...(cf ? { cf } : {}) } as RequestInit)).json()) as any;
  const open = async (code: string, cookie: string, cf?: object) => (await hub(`/pair?code=${code}`, { headers: { Cookie: cookie }, ...(cf ? { cf } : {}) } as RequestInit)).text();
  const buttons = (html: string) => /<p><button[^]*?<\/p>/.exec(html)![0];

  it('a code lives 5 minutes (was 10: the time a phisher has to get it clicked)', async () => {
    const s = await start(SEATTLE);
    expect(s.expiresIn).toBe(300);
    const { keys } = await oauthKv(env).list({ prefix: `pair:${s.code}` });
    expect(keys).toHaveLength(1);
    const left = keys[0].expiration! * 1000 - Date.now();
    expect(left).toBeGreaterThan(290_000);
    expect(left).toBeLessThanOrEqual(300_000);
  });
  it('the page says when and roughly where the request started', async () => {
    const cookie = await cookieFor(newUser());
    const s = await start(SEATTLE);
    const html = await open(s.code, cookie, SEATTLE);
    expect(html).toContain('Started less than a minute ago, from around Seattle, United States. Code');
    expect(html).not.toContain('class="warn"');
    expect(buttons(html)).toBe('<p><button name="decision" value="approve">Connect</button> <button class="secondary" name="decision" value="deny">Deny</button></p>');
    // Three minutes later, the same page says so.
    const store = oauthKv(env);
    const raw = JSON.parse((await store.get(`pair:${s.code}`)) as string);
    await store.put(`pair:${s.code}`, JSON.stringify({ ...raw, started: raw.started - 3 * 60_000 }), { expirationTtl: 120 });
    expect(await open(s.code, cookie, SEATTLE)).toContain('Started 3 minutes ago, from around Seattle, United States.');
  });
  it('a request from another country than the page warns and makes Deny the main button', async () => {
    const cookie = await cookieFor(newUser());
    const s = await start(LAGOS);
    const html = await open(s.code, cookie, SEATTLE);
    expect(html).toContain('<p class="warn"><strong>Careful: this didn\'t start where you are.</strong> It started from around Lagos, Nigeria, and this page opened from around Seattle, United States. Click Deny unless you\'re sure you just clicked Connect yourself.</p>');
    expect(buttons(html)).toBe('<p><button class="secondary" name="decision" value="approve">Connect</button> <button name="decision" value="deny">Deny</button></p>');
    // Still the user's call: Connect works.
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const ok = await hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: s.code, csrf, decision: 'approve' }) });
    expect(ok.status).toBe(200);
  });
  it('Tor and unknown places read plainly; a place Cloudflare left out is skipped, never guessed', async () => {
    const cookie = await cookieFor(newUser());
    const tor = await start({ country: 'T1' });
    expect(await open(tor.code, cookie, { country: 'T1' })).toContain('Started less than a minute ago, from the Tor network. Code');
    const torElsewhere = await open(tor.code, cookie, SEATTLE);
    expect(torElsewhere).toContain('It started from the Tor network, and this page opened from around Seattle, United States.');
    const unknown = await start({ country: 'XX' });
    const u = await open(unknown.code, cookie, SEATTLE);
    expect(u).toContain('Started less than a minute ago. Code');
    expect(u).not.toContain('class="warn"'); // no country to compare
    const cityOnly = await start({ city: 'Springfield' });
    expect(await open(cityOnly.code, cookie)).toContain('Started less than a minute ago, from around Springfield. Code');
  });
  it('a city name is escaped on the page', async () => {
    const cookie = await cookieFor(newUser());
    const s = await start({ city: '<img src=x onerror=alert(1)>', country: 'US' });
    const html = await open(s.code, cookie);
    expect(html).toContain('from around &#60;img src=x onerror=alert(1)&#62;, United States.');
    expect(html).not.toContain('<img src=x');
  });
  it('a code from before S2c (no time or place) still shows its page', async () => {
    const cookie = await cookieFor(newUser());
    const s = await start(SEATTLE);
    const store = oauthKv(env);
    const { started, from, ...old } = JSON.parse((await store.get(`pair:${s.code}`)) as string);
    expect([typeof started, from]).toEqual(['number', SEATTLE]);
    await store.put(`pair:${s.code}`, JSON.stringify(old), { expirationTtl: 120 });
    const html = await open(s.code, cookie, LAGOS);
    expect(html).toContain('<p class="note">Code <code>');
    expect(html).not.toContain('class="warn"');
  });
});

describe('arm socket', () => {
  it('a bad or unknown token is accepted then closed with 4401 and the next step', async () => {
    const bad = await connectArm('cba_bm9wZQ.' + 'x'.repeat(43), { name: 'x' });
    expect(await bad.closed).toEqual({ code: 4401, reason: 'unknown or revoked arm token: pair this arm again' });
    const malformed = await connectArm('garbage', { name: 'x' });
    expect((await malformed.closed).code).toBe(4401);
  });
  it('a forged token stores nothing in the user hub it names (S1: each one kept rows forever)', async () => {
    const name = `gh-forged-${crypto.randomUUID()}`;
    const forged = `cba_${btoa(name).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${'x'.repeat(43)}`;
    const ws = await connectArm(forged, { name: 'x' });
    expect((await ws.closed).code).toBe(4401);
    const revoke = await hub('/arm/revoke', { method: 'POST', headers: { Authorization: `Bearer ${forged}` } });
    expect(((await revoke.json()) as any).revoked).toBe(false);
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(name));
    expect(await stub.listTools()).toHaveLength(CHROME.length); // reads still answer: nothing paired
    const tables = await runInDurableObject(stub, (_: UserHub, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray());
    expect(tables).toEqual([]);
  });
  it('hello gets the policy, then a tools/list; ping is answered with pong', async () => {
    const cookie = await cookieFor(newUser());
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const a = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await a.ready;
    expect(a.received.map((m) => m.method)).toEqual(['arm/policy', 'tools/list']);
    a.ws.send('ping');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.received.at(-1)).toEqual({ method: 'pong' });
    a.ws.close();
  });
  it('a newer connection of the same arm replaces the old one', async () => {
    const { token } = await pairArm(await cookieFor(newUser()), 'fake', 'birch');
    const first = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await first.ready;
    const second = await connectArm(token, { name: 'birch', tools: [ECHO] });
    expect((await first.closed).code).toBe(4000);
    second.ws.close();
  });
  it('a second hello on one socket closes it instead of rewriting the arm (S1: a write-budget flood)', async () => {
    const { token } = await pairArm(await cookieFor(newUser()), 'fake', 'birch');
    const a = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await a.ready;
    for (let i = 0; i < 3; i++) a.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/hello', params: { kind: 'fake', name: 'birch', version: '0.1.0' } }));
    const closed = await Promise.race([a.closed, new Promise((r) => setTimeout(() => r('still open'), 500))]);
    expect(closed).toEqual({ code: 4400, reason: 'arm/hello is sent once per connection: reconnect to announce again' });
    expect(a.received.filter((m) => m.method === 'tools/list')).toHaveLength(1);
  });
});

describe('replaced connections', () => {
  it('a replaced socket closing late does not fail a call running on its successor', async () => {
    const user = newUser();
    const { token } = await pairArm(await cookieFor(user), 'fake', 'birch');
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    const first = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await first.ready;
    const old = await runInDurableObject(stub, (_: UserHub, state) => state.getWebSockets()[0]);
    const second = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: () => undefined }); // answered by hand below
    await second.ready;
    const call = stub.callTool('fake_echo', { text: 'x' });
    await new Promise((r) => setTimeout(r, 30));
    const req = second.received.find((m) => m.method === 'tools/call')!;
    await runInDurableObject(stub, (hub: UserHub) => hub.webSocketClose(old, 1006, 'late'));
    second.ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    const res = await call;
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('ok');
    second.ws.close();
  });
});

describe('MCP through OAuth to arms', () => {
  it('lists namespaced tools and round-trips a call through the hub to the arm', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO, SNAP], onCall: (p) => ({ content: [{ type: 'text', text: `${p.name}:${p.arguments.text}` }] }) });
    await arm.ready;
    const client = await mcpClient(await accessToken(cookie));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...CHROME, 'fake_echo', 'fake_snap']);
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi' } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('echo:hi');
    const call = arm.received.find((m) => m.method === 'tools/call')!;
    expect(call.params).toMatchObject({ name: 'echo', arguments: { text: 'hi' } });
    const hubStub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    const [row] = await hubStub.recentActivity(1);
    expect(row).toMatchObject({ command: 'fake_echo', ok: 1 });
    expect(row.client).toBeTruthy();
    arm.ws.close();
  });
  it('activity never stores the arm\'s error text, which can echo arguments', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: (p) => ({ content: [{ type: 'text', text: `$ fill x @e5 -- ${p.arguments.text}` }], isError: true }) });
    await arm.ready;
    const client = await mcpClient(await accessToken(cookie));
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'hunter2' } });
    expect(text(res)).toContain('hunter2'); // the caller still gets the arm's answer
    const [row] = await env.USER_HUB.get(env.USER_HUB.idFromName(user.uid)).recentActivity(1);
    expect(row).toMatchObject({ command: 'fake_echo', ok: 0, error: 'the arm reported an error' });
    expect(JSON.stringify(row)).not.toContain('hunter2');
    arm.ws.close();
  });
  it('another user sees none of these arms', async () => {
    const owner = await cookieFor(newUser());
    const { token } = await pairArm(owner, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await arm.ready;
    const client = await mcpClient(await accessToken(await cookieFor(newUser())));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CHROME); // the built-in Chrome tools only
    arm.ws.close();
  });
  it('a disconnected arm answers with what to do next', async () => {
    const cookie = await cookieFor(newUser());
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], offlineHint: 'Ask the user to run the fake arm' });
    await arm.ready;
    arm.ws.close(1000, 'bye');
    await new Promise((r) => setTimeout(r, 50));
    const client = await mcpClient(await accessToken(cookie));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...CHROME, 'fake_echo']);
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^No fake is online \(paired: birch, last seen \d+s ago\)\. It reconnects by itself within about a minute after the computer wakes up or its network comes back, so calling again in a minute may work\. If it doesn't: Ask the user to run the fake arm, then call this tool again\.$/);
  });
  it('an arm that drops mid-call or never answers fails the call with a check-state hint', async () => {
    const cookie = await cookieFor(newUser());
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: () => { setTimeout(() => arm.ws.close(1001, 'gone'), 10); return undefined; } });
    await arm.ready;
    const client = await mcpClient(await accessToken(cookie));
    const dropped = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi' } });
    expect(text(dropped)).toBe('The fake "birch" failed on fake_echo: the arm disconnected (1001 gone) before answering. The command may or may not have run: check the current state before retrying.');
    const { token: t2 } = await pairArm(cookie, 'fake', 'oak');
    const silent = await connectArm(t2, { name: 'oak', tools: [ECHO], onCall: () => undefined });
    await silent.ready;
    const timedOut = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi', arm: 'oak' } });
    expect(text(timedOut)).toContain(`failed on fake_echo: the arm didn't answer within 1s.`);
    silent.ws.close();
  });
  it('two arms of a kind: the selector is required and routes', async () => {
    const cookie = await cookieFor(newUser());
    const mk = async (name: string) => {
      const { token } = await pairArm(cookie, 'fake', name);
      const a = await connectArm(token, { name, tools: [ECHO], onCall: () => ({ content: [{ type: 'text', text: name }] }) });
      await a.ready;
      return a;
    };
    const [birch, oak] = [await mk('birch'), await mk('oak')];
    const client = await mcpClient(await accessToken(cookie));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'fake_echo')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['text', 'arm']);
    expect(text(await client.callTool({ name: 'fake_echo', arguments: { text: 'x' } }))).toContain('Several fakes are online: birch, oak. Pass arm');
    expect(text(await client.callTool({ name: 'fake_echo', arguments: { text: 'x', arm: 'oak' } }))).toBe('oak');
    birch.ws.close();
    oak.ws.close();
  });
});

const pages = async (...paths: string[]) => Promise.all(paths.map(async (p) => (await hub(p)).text()));
// People never read "arm", "hub" or "MCP" on a page. Exceptions: the connector link
// (it ends in /mcp) and ChatGPT's own button label, which they must find verbatim.
const plain = (html: string) =>
  html.replace(/<script>[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace('Add custom MCP server', ' ');

describe('signing out (off → on → off leaves at most one record: the arm revokes its old token)', () => {
  const revoke = (token: string) => hub('/arm/revoke', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  it('revoke drops the record and its socket; a second revoke is still ok', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const { token } = await pairArm(cookie, 'chrome', 'poplar');
    const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', tools: [ECHO] });
    await arm.ready;
    const res = await revoke(token);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(await arm.closed).toEqual({ code: 4401, reason: 'signed out of Cloud Bridge' });
    expect(await env.USER_HUB.get(env.USER_HUB.idFromName(user.uid)).armSummary()).toEqual([]);
    expect(await (await revoke(token)).json()).toEqual({ ok: true, revoked: false });
    // The token no longer opens a socket.
    expect((await (await connectArm(token, { name: 'poplar' })).closed).code).toBe(4401);
  });
  it('a malformed token is refused with the expected shape', async () => {
    const res = await hub('/arm/revoke', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toContain('Authorization: Bearer cba_');
  });
  it('pairing never replaces another record by name: two profiles can share one', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const first = await pairArm(cookie, 'chrome', 'oak');
    await pairArm(cookie, 'chrome', 'Oak');
    expect((await env.USER_HUB.get(env.USER_HUB.idFromName(user.uid)).armSummary()).map((a) => a.name)).toEqual(['oak', 'Oak']);
    const a = await connectArm(first.token, { kind: 'chrome', name: 'oak', tools: [ECHO] });
    await a.ready; // the first profile's token still works
    a.ws.close();
  });
  it('revoking mid-call fails the call with the check-state hint', async () => {
    const cookie = await cookieFor(newUser());
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: () => undefined });
    await arm.ready;
    const client = await mcpClient(await accessToken(cookie));
    const call = client.callTool({ name: 'fake_echo', arguments: { text: 'x' } });
    await new Promise((r) => setTimeout(r, 30));
    await revoke(token);
    expect(text(await call)).toContain('failed on fake_echo: the arm signed out of Cloud Bridge before answering.');
  });
});

describe('arm/download (files for an upload, fetched by the hub)', () => {
  it('answers an arm\'s request with the next step when the URL is private, without fetching', async () => {
    const cookie = await cookieFor(newUser());
    const { token } = await pairArm(cookie, 'chrome', 'poplar');
    const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: [] });
    await arm.ready;
    arm.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'd1', method: 'arm/download', params: { url: 'http://localhost./secret' } }));
    arm.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'd2', method: 'arm/download', params: {} }));
    await new Promise((r) => setTimeout(r, 50));
    const answers = arm.received.filter((m: any) => m.id === 'd1' || m.id === 'd2') as any[];
    expect(answers.map((m) => [m.id, m.error?.message])).toEqual([
      ['d1', 'localhost. is a private-network address; Cloud Bridge only downloads upload files from public addresses — send the file as base64 instead'],
      ['d2', ' is not an http(s) URL'],
    ]);
    arm.ws.close();
  });
});

describe('a connector added before Chrome pairs', () => {
  it('already lists chrome and chrome_batch, which answer with how to connect Chrome', async () => {
    const cookie = await cookieFor(newUser());
    const client = await mcpClient(await accessToken(cookie));
    const listed = (await client.listTools()).tools;
    const before = listed.map((t) => t.name);
    expect(before).toEqual(CHROME);
    // Through the real MCP server: annotations reach the client (AI apps skip the prompt on read-only tools), and so does profile.
    const snap = listed.find((t) => t.name === 'chrome_snap')!;
    expect(snap.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(listed.find((t) => t.name === 'chrome_click')!.annotations).toMatchObject({ readOnlyHint: false });
    expect(snap.inputSchema.properties).toHaveProperty('profile');
    expect(snap.inputSchema.required).toEqual(['tab']);
    const res = await client.callTool({ name: 'chrome', arguments: { command: 'tabs' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^No Chrome is connected to the user's Cloud Bridge yet, so nothing ran\. .*⚙ Settings → Cloud AI apps → Connect\. Once they have, call this tool again\.$/);
    // Chrome pairs later: same names, now the arm's own tools, and the cached name routes.
    const { token } = await pairArm(cookie, 'chrome', 'poplar');
    const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: chromeTools.map((t) => (t.name === 'chrome' ? { ...t, description: 'real' } : t)) as any, onCall: (p) => ({ content: [{ type: 'text', text: `ran ${p.arguments.command}` }] }) });
    await arm.ready;
    const after = (await client.listTools()).tools;
    expect(after.map((t) => t.name)).toEqual(before);
    expect(after[0].description).toBe('real');
    expect(text(await client.callTool({ name: 'chrome', arguments: { command: 'tabs' } }))).toBe('ran tabs');
    arm.ws.close();
  });
});

describe('pages people read', () => {
  it('the consent page names the connected profiles and where access goes', async () => {
    const cookie = await cookieFor(newUser());
    await pairArm(cookie, 'chrome', 'poplar');
    const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', token_endpoint_auth_method: 'none' }) })).json()) as any;
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
    const html = await (await hub(`/authorize?${q}`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Allow Claude to use your Chrome?');
    expect(html).toContain('<strong>Chrome profile “poplar”</strong>');
    expect(html).toContain("Access goes to <strong>claude.ai</strong>. Continue only if you're adding Cloud Bridge in Claude right now.");
    expect(html).not.toContain('not verified');
    expect(html).not.toContain('Careful');
    expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b/i);
  });
  it('an app that calls itself Claude or ChatGPT but sends access elsewhere is called out (S1)', async () => {
    const cookie = await cookieFor(newUser());
    const consent = async (client_name: string, redirect: string) => {
      const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name, token_endpoint_auth_method: 'none' }) })).json()) as any;
      const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
      return (await hub(`/authorize?${q}`, { headers: { Cookie: cookie } })).text();
    };
    const fake = await consent('Claude', 'https://claude.ai.evil.example/api/mcp/auth_callback');
    expect(fake).toContain('Allow an app calling itself Claude to use your Chrome?');
    expect(fake).toContain('Careful: this may not be Claude.</strong> It calls itself Claude, but Claude sends you back to claude.ai, and this app sends access to <strong>claude.ai.evil.example</strong>. Click Deny unless you set this app up yourself.');
    expect(fake).toContain('<button class="secondary" name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button>');
    expect(await consent('ChatGPT connector', 'https://chatgpt.evil.example/cb')).toContain('Careful: this may not be ChatGPT.');
    // The real ones, an app on this computer, and apps that claim no vendor's name pass quietly.
    for (const [name, redirect] of [['ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect'], ['Claude', 'https://claude.ai/api/mcp/auth_callback'], ['Claude Code', 'http://127.0.0.1:33418/callback'], ['My tool', 'https://tool.example/cb']]) {
      expect(await consent(name, redirect)).not.toContain('Careful');
    }
  });
  it('the pairing page shows the code and says where to compare it; Connect leads to adding the AI app', async () => {
    const cookie = await cookieFor(newUser());
    const start = (await (await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'chrome', name: 'poplar' }) })).json()) as any;
    const html = await (await hub(`/pair?code=${start.code}`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Connect Chrome profile “poplar”?');
    // The decision first, in people's words; the code is the cross-check, and the
    // toolbar icon shows it (the popup closes when this page opens — Ivan, live).
    expect(html).toContain('Did you just click <strong>Connect</strong> in the chrome-bridge extension? Then click Connect below. If you didn\'t, click Deny');
    expect(html).toContain(`Code <code>${start.code}</code>. The chrome-bridge icon in your Chrome toolbar shows the same code while it waits.`);
    expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b/i);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const done = await hub('/pair/approve', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.code, csrf, decision: 'approve' }) });
    const next = await done.text();
    expect(next).toContain('<h1>✅ Chrome profile “poplar” is connected</h1>');
    expect(next).toContain("You're done: you can close this tab.");
    expect(next).toContain('Next: add Cloud Bridge to your AI app');
    expect(next).toContain(`<code>${ORIGIN}/mcp</code>`);
    expect(next).toContain('href="https://claude.ai/customize/connectors"');
    expect(next).toContain('href="https://chatgpt.com/plugins"');
    expect(plain(next)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b/i);
  });
  it('/ is a three-step guide and /add puts the chosen app first; both allow only their copy script', async () => {
    const [home, chatgpt, claude] = await pages('/', '/add?app=chatgpt', '/add');
    expect(home).toContain('<title>Cloud Bridge</title>'); // not "Cloud Bridge · Cloud Bridge"
    expect(chatgpt).toContain('<title>Add Cloud Bridge to ChatGPT · Cloud Bridge</title>');
    expect(home).toContain('Install chrome-bridge');
    expect(home).toContain('Connect your Chrome');
    expect(home).toContain('Add Cloud Bridge to your AI app');
    expect(chatgpt).toContain('Add Cloud Bridge to ChatGPT');
    expect(chatgpt.indexOf('<h2>ChatGPT')).toBeLessThan(chatgpt.indexOf('<h2>Claude'));
    expect(claude.indexOf('<h2>Claude')).toBeLessThan(claude.indexOf('<h2>ChatGPT'));
    for (const html of [home, chatgpt, claude]) expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b/i);
    const csp = (await hub('/')).headers.get('Content-Security-Policy')!;
    expect(csp).toContain(`script-src 'sha256-${COPY_SCRIPT.hash}'`);
  });
  it('every page has a favicon the CSP allows (without one Chrome showed a placeholder Ivan read as a clock)', async () => {
    const home = await hub('/');
    expect(await home.text()).toContain('<link rel="icon" href="/favicon.svg"');
    expect(home.headers.get('Content-Security-Policy')).toContain("img-src 'self'");
    const icon = await hub('/favicon.svg');
    expect(icon.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await icon.text()).toContain('<svg');
    expect((await hub('/favicon.ico')).status).toBe(200);
  });
  it('the pinned CSP hash is the copy script\'s real hash', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(COPY_SCRIPT.code));
    expect(btoa(String.fromCharCode(...new Uint8Array(digest)))).toBe(COPY_SCRIPT.hash);
  });
});

describe('heartbeats', () => {
  it('a socket that stopped pinging counts as offline and is closed, instead of a call waiting out the timeout', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const { token } = await pairArm(cookie, 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: () => undefined, offlineHint: 'Ask the user to run the fake arm' });
    await arm.ready;
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    // Opened 10 minutes ago, never pinged since: dead without a close frame.
    await runInDurableObject(stub, (_: UserHub, state) => {
      const ws = state.getWebSockets()[0];
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), since: Date.now() - 10 * 60_000 });
      state.storage.sql.exec('UPDATE arms SET last_seen = ?', Date.now() - 10 * 60_000);
    });
    const started = Date.now();
    const res = await stub.callTool('fake_echo', { text: 'x' });
    expect(Date.now() - started).toBeLessThan(1000);
    // Last seen when it last pinged, not when the hub noticed (found live: a Chrome asleep all night read "7s ago").
    expect(res.content[0].text).toMatch(/^No fake is online \(paired: birch, last seen 10 min ago\)\. It reconnects by itself within about a minute after the computer wakes up or its network comes back, so calling again in a minute may work\. If it doesn't: Ask the user to run the fake arm, then call this tool again\.$/);
    expect((await arm.closed).code).toBe(4003);
  });
  it('a pinging socket stays online', async () => {
    const user = newUser();
    const { token } = await pairArm(await cookieFor(user), 'fake', 'birch');
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: () => ({ content: [{ type: 'text', text: 'ok' }] }) });
    await arm.ready;
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    await runInDurableObject(stub, (_: UserHub, state) => {
      const ws = state.getWebSockets()[0];
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), since: Date.now() - 10 * 60_000 });
    });
    arm.ws.send('ping');
    await new Promise((r) => setTimeout(r, 50));
    expect((await stub.callTool('fake_echo', { text: 'x' })).content[0].text).toBe('ok');
    arm.ws.close();
  });
});
