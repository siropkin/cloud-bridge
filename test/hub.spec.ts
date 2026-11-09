import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { safeNext } from '../src/auth';
import type { UserHub } from '../src/hub';
import { describe, expect, it } from 'vitest';
import { COPY_SCRIPT } from '../src/guide';
import { accessToken, connectArm, cookieFor, ECHO, hub, mcpClient, newUser, ORIGIN, pairArm, SNAP } from './helpers';

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

describe('arm socket', () => {
  it('a bad or unknown token is accepted then closed with 4401 and the next step', async () => {
    const bad = await connectArm('cba_bm9wZQ.' + 'x'.repeat(43), { name: 'x' });
    expect(await bad.closed).toEqual({ code: 4401, reason: 'unknown or revoked arm token: pair this arm again' });
    const malformed = await connectArm('garbage', { name: 'x' });
    expect((await malformed.closed).code).toBe(4401);
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
    expect(tools.map((t) => t.name)).toEqual(['chrome', 'chrome_batch', 'fake_echo', 'fake_snap']);
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
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['chrome', 'chrome_batch']); // the built-in Chrome tools only
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
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['chrome', 'chrome_batch', 'fake_echo']);
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^No fake is online \(paired: birch, last seen \d+s ago\)\. Ask the user to run the fake arm, then call this tool again\.$/);
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

describe('a connector added before Chrome pairs', () => {
  it('already lists chrome and chrome_batch, which answer with how to connect Chrome', async () => {
    const cookie = await cookieFor(newUser());
    const client = await mcpClient(await accessToken(cookie));
    const before = (await client.listTools()).tools.map((t) => t.name);
    expect(before).toEqual(['chrome', 'chrome_batch']);
    const res = await client.callTool({ name: 'chrome', arguments: { command: 'tabs' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^No Chrome is connected to the user's Cloud Bridge yet, so nothing ran\. .*⚙ Settings → Cloud AI apps → Connect\. Once they have, call this tool again\.$/);
    // Chrome pairs later: same names, now the arm's own tools, and the cached name routes.
    const { token } = await pairArm(cookie, 'chrome', 'poplar');
    const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: [{ name: 'chrome', description: 'real', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }, { name: 'chrome_batch', inputSchema: { type: 'object' } }], onCall: (p) => ({ content: [{ type: 'text', text: `ran ${p.arguments.command}` }] }) });
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
    expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b/i);
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
