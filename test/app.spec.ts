import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserHub } from '../src/hub';
import { COPY_SCRIPT } from '../src/guide';
import { ECHO, ORIGIN, accessToken, connectArm, cookieFor, hub, mcpClient, newUser, pairArm } from './helpers';

// People never read "arm", "hub", "pair" or "MCP" here. <code> is what they copy
// verbatim (the link ends in /mcp, Claude Code's command says "mcp").
const plain = (html: string) =>
  html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace('Add custom MCP server', ' ');
const JARGON = /\barms?\b|\bhub\b|\bMCP\b|\bpair/i;

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1];
const form = (path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  hub(path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: new URLSearchParams(fields) });
// The account's form token (the same on every form; /app/delete always has one).
const tokenOf = async (cookie: string) => csrfOf(await (await hub('/app/delete', { headers: { Cookie: cookie } })).text());
const appHtml = async (cookie: string, query = '') => (await hub(`/app${query}`, { headers: { Cookie: cookie } })).text();
const stubOf = (uid: string) => env.USER_HUB.get(env.USER_HUB.idFromName(uid));

async function signedIn() {
  const user = newUser();
  const cookie = await cookieFor(user);
  return { user, cookie };
}

async function chrome(cookie: string, name: string, onCall?: (p: any) => unknown) {
  const { token } = await pairArm(cookie, 'chrome', name);
  const arm = await connectArm(token, { kind: 'chrome', name, selector: 'profile', tools: [ECHO], onCall });
  await arm.ready;
  return { token, arm };
}

const armIds = async (uid: string) => (await stubOf(uid).armDetails()).map((a) => [a.id, a.name] as const);

describe('the account page (/app)', () => {
  it('signs you in first, then comes back here', async () => {
    const res = await hub('/app', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/login?next=%2Fapp`);
    // A form posted while signed out: sign in, then the page, not the POST's path.
    const post = await hub('/app/rename', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=x&id=y&name=z' });
    expect(post.status).toBe(303);
    expect(post.headers.get('Location')).toBe(`${ORIGIN}/login?next=/app`);
  });

  it('a new account says what to do first, in plain words, with every way to add the link', async () => {
    const { user, cookie } = await signedIn();
    const res = await hub('/app', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('<title>Your Cloud Bridge · Cloud Bridge</title>');
    expect(html).toContain(`Signed in with GitHub as <strong>@${user.login}</strong>`);
    expect(html).toContain('No Chrome is connected yet. Click the chrome-bridge icon in your Chrome toolbar → ⚙ Settings → <b>Cloud AI apps</b> → Connect.');
    expect(html).toContain('None yet. Add Cloud Bridge to one below.');
    expect(html).toContain(`<code>${ORIGIN}/mcp</code>`);
    expect(html).toContain(`<code>claude mcp add --transport http cloud-bridge ${ORIGIN}/mcp</code>`);
    expect(html).toContain(`<code>{"mcpServers":{"cloud-bridge":{"url":"${ORIGIN}/mcp"}}}</code>`);
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain('<a href="/app/delete">Delete my data…</a>');
    expect(plain(html)).not.toMatch(JARGON);
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain(`script-src 'sha256-${COPY_SCRIPT.hash}'`);
    // Looking writes nothing: no tables for an account that never connected anything.
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'arms'").toArray()).toEqual([]);
    });
  });

  it('lists each Chrome profile (online or not, version, since when) and each AI app you allowed', async () => {
    const { user, cookie } = await signedIn();
    const { arm } = await chrome(cookie, 'poplar');
    await pairArm(cookie, 'chrome', 'hazel'); // paired, never connected
    await accessToken(cookie); // "Test client", access sent to 127.0.0.1
    const html = await appHtml(cookie);
    expect(html).toMatch(/<span class="dot on"><\/span><strong>Chrome profile “poplar”<\/strong><br><span class="note">Online now · version 0\.1\.0 · connected \w{3} \d{1,2}, \d{4}<\/span>/);
    expect(html).toMatch(/<span class="dot off"><\/span><strong>Chrome profile “hazel”<\/strong><br><span class="note">Offline, never connected · connected /);
    expect(html).toMatch(/<strong>Test client<\/strong><br><span class="note">Access goes to 127\.0\.0\.1 · allowed \w{3} \d{1,2}, \d{4}<\/span>/);
    expect(html.match(/action="\/app\/rename"/g)).toHaveLength(2);
    expect(html.match(/action="\/app\/disconnect"/g)).toHaveLength(2);
    expect(html.match(/action="\/app\/forget"/g)).toHaveLength(1);
    expect(plain(html)).not.toMatch(JARGON);
    // Another account sees none of it.
    const other = await appHtml((await signedIn()).cookie);
    expect(other).not.toContain('poplar');
    expect(other).not.toContain('Test client');
    expect(user.uid).toBeTruthy();
    arm.ws.close();
  });

  it('a name from the account is escaped', async () => {
    const { cookie } = await signedIn();
    await pairArm(cookie, 'chrome', '<img src=x onerror=alert(1)>');
    const html = await appHtml(cookie);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
  });
});

describe('renaming a Chrome profile', () => {
  it('AI apps pick it by the new name from their next call', async () => {
    const { user, cookie } = await signedIn();
    const calls: any[] = [];
    const { token, arm } = await chrome(cookie, 'poplar', (p) => (calls.push(p), { content: [{ type: 'text', text: 'ok' }] }));
    const [[id]] = await armIds(user.uid);
    const csrf = csrfOf(await appHtml(cookie));
    const res = await form('/app/rename', cookie, { csrf, id, name: '  Work laptop  ' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app?done=renamed`);
    expect(await armIds(user.uid)).toEqual([[id, 'Work laptop']]);
    expect(await appHtml(cookie, '?done=renamed')).toContain('<p class="ok">Renamed. AI apps use the new name from their next call.</p>');
    const client = await mcpClient(await accessToken(cookie));
    const tools = (await client.listTools()).tools;
    expect(JSON.stringify(tools.find((t) => t.name === 'chrome_echo'))).toContain('connected: Work laptop');
    const result = await client.callTool({ name: 'chrome_echo', arguments: { text: 'hi', profile: 'work LAPTOP' } });
    expect(result.isError).toBeFalsy();
    expect(calls[0].arguments).toEqual({ text: 'hi' }); // the arm never sees the hub-side name
    const old = await client.callTool({ name: 'chrome_echo', arguments: { text: 'hi', profile: 'poplar' } });
    expect((old.content as any)[0].text).toBe('No chrome named "poplar". Online: Work laptop. Pass profile as one of those names.');
    // The arm hears the new name at once (a "--profile Work laptop" inside a command line is its to check), and again on every connection.
    expect(arm.received.filter((m) => m.method === 'arm/name').map((m) => m.params.name)).toEqual(['poplar', 'Work laptop']);
    arm.ws.close();
    const again = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: [ECHO] });
    await again.ready;
    expect(again.received.find((m) => m.method === 'arm/name')?.params).toEqual({ name: 'Work laptop' });
    again.ws.close();
  });

  it("refuses a name another profile has (any case), an empty or too long one, and says nothing changed", async () => {
    const { user, cookie } = await signedIn();
    await pairArm(cookie, 'chrome', 'poplar');
    await pairArm(cookie, 'chrome', 'hazel');
    const [[a], [b]] = await armIds(user.uid);
    const csrf = csrfOf(await appHtml(cookie));
    const rename = async (id: string, name: string) => (await form('/app/rename', cookie, { csrf, id, name })).headers.get('Location');
    expect(await rename(a, 'HAZEL')).toBe(`${ORIGIN}/app?error=taken`);
    // Any alphabet, folded the way calls pick a profile (review: SQLite's lower() folds only A-Z).
    expect(await rename(b, 'Работа')).toBe(`${ORIGIN}/app?done=renamed`);
    expect(await rename(a, 'РАБОТА')).toBe(`${ORIGIN}/app?error=taken`);
    expect(await rename(a, 'работа')).toBe(`${ORIGIN}/app?error=taken`);
    expect(await rename(b, 'hazel')).toBe(`${ORIGIN}/app?done=renamed`);
    expect(await rename(a, '   ')).toBe(`${ORIGIN}/app?error=invalid`);
    expect(await rename(a, 'x'.repeat(65))).toBe(`${ORIGIN}/app?error=invalid`);
    expect(await rename(a, 'tab\there')).toBe(`${ORIGIN}/app?error=invalid`);
    expect(await rename(b, 'Hazel')).toBe(`${ORIGIN}/app?done=renamed`); // its own name in another case is fine
    expect(await armIds(user.uid)).toEqual([[a, 'poplar'], [b, 'Hazel']]);
    expect(await appHtml(cookie, '?error=taken')).toContain('<p class="warn">Another Chrome profile already has that name, so nothing changed. Pick a different name.</p>');
    // Only fixed messages: nothing from the query string reaches the page.
    expect(await appHtml(cookie, '?error=<b>x</b>')).not.toContain('<b>x</b>');
  });

  it("can't touch another account's profile, and refuses a form from another site or an old page", async () => {
    const { user, cookie } = await signedIn();
    await pairArm(cookie, 'chrome', 'poplar');
    const [[id]] = await armIds(user.uid);
    const intruder = await signedIn();
    const theirCsrf = await tokenOf(intruder.cookie);
    expect((await form('/app/rename', intruder.cookie, { csrf: theirCsrf, id, name: 'mine' })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    expect((await form('/app/disconnect', intruder.cookie, { csrf: theirCsrf, id })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    // The owner's cookie with another account's token, or a cross-site post: nothing changes.
    expect((await form('/app/rename', cookie, { csrf: theirCsrf, id, name: 'x' })).headers.get('Location')).toBe(`${ORIGIN}/app?error=stale`);
    const csrf = csrfOf(await appHtml(cookie));
    expect((await form('/app/disconnect', cookie, { csrf, id }, { 'Sec-Fetch-Site': 'cross-site' })).headers.get('Location')).toBe(`${ORIGIN}/app?error=stale`);
    expect((await form('/app/disconnect', cookie, { csrf, id }, { 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.example' })).headers.get('Location')).toBe(`${ORIGIN}/app?error=stale`);
    expect(await armIds(user.uid)).toEqual([[id, 'poplar']]);
    expect(await appHtml(cookie, '?error=stale')).toContain('This page was out of date, so nothing changed. Try again.');
  });
});

describe('disconnecting a Chrome profile', () => {
  it('drops its socket at once with 4401 (the extension stops redialing), and AI apps stop seeing it', async () => {
    const { user, cookie } = await signedIn();
    const { token, arm } = await chrome(cookie, 'poplar');
    const [[id]] = await armIds(user.uid);
    const csrf = csrfOf(await appHtml(cookie));
    const res = await form('/app/disconnect', cookie, { csrf, id });
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app?done=disconnected`);
    expect(await arm.closed).toEqual({ code: 4401, reason: 'disconnected on the Cloud Bridge page' });
    expect(await armIds(user.uid)).toEqual([]);
    // Its token is dead: a redial is refused.
    const again = await connectArm(token, { kind: 'chrome', name: 'poplar' });
    expect((await again.closed).code).toBe(4401);
    expect((await form('/app/disconnect', cookie, { csrf, id })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    expect(await appHtml(cookie, '?done=disconnected')).toContain("Disconnected. AI apps can't use that Chrome profile until you connect it again from the chrome-bridge popup.");
  });
});

describe('removing an AI app', () => {
  it('signs it out at once: its access token stops working, and the list no longer shows it', async () => {
    const { user, cookie } = await signedIn();
    const token = await accessToken(cookie);
    await (await mcpClient(token)).listTools();
    const html = await appHtml(cookie);
    const grant = /name="grant" value="([^"]+)"/.exec(html)![1];
    const res = await form('/app/forget', cookie, { csrf: csrfOf(html), grant });
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app?done=removed`);
    await expect(mcpClient(token)).rejects.toThrow();
    const after = await appHtml(cookie, '?done=removed');
    expect(after).toContain("Removed. That AI app can't use your Chrome until you allow it again.");
    expect(after).toContain('None yet. Add Cloud Bridge to one below.');
    // Again, a bogus id or another account's grant: nothing to remove.
    const csrf = await tokenOf(cookie);
    expect((await form('/app/forget', cookie, { csrf, grant })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    expect((await form('/app/forget', cookie, { csrf, grant: '../x:y' })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    const other = await signedIn();
    const otherToken = await accessToken(other.cookie);
    const otherGrant = /name="grant" value="([^"]+)"/.exec(await appHtml(other.cookie))![1];
    expect((await form('/app/forget', cookie, { csrf, grant: otherGrant })).headers.get('Location')).toBe(`${ORIGIN}/app?error=gone`);
    await (await mcpClient(otherToken)).listTools(); // still works
    expect(user.uid).not.toBe(other.user.uid);
  });
});

describe('deleting your data', () => {
  it('asks first, on its own page', async () => {
    const { user, cookie } = await signedIn();
    const res = await hub('/app/delete', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('<title>Delete your Cloud Bridge data? · Cloud Bridge</title>');
    expect(html).toContain(`connected to <strong>@${user.login}</strong>`);
    expect(html).toContain('<form method="post" action="/app/delete">');
    expect(html).toContain('<button class="danger">Delete everything</button> <a class="button" href="/app">Cancel</a>');
    expect(plain(html)).not.toMatch(JARGON);
    expect((await hub('/app/delete', { redirect: 'manual' })).headers.get('Location')).toBe(`${ORIGIN}/login?next=%2Fapp%2Fdelete`);
  });

  it('signs out every profile and app, deletes profiles, activity, files and grants, and signs you out', async () => {
    const { user, cookie } = await signedIn();
    const { token: armToken, arm } = await chrome(cookie, 'poplar', () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await pairArm(cookie, 'chrome', 'hazel');
    const token = await accessToken(cookie);
    const client = await mcpClient(token);
    await client.callTool({ name: 'chrome_echo', arguments: { text: 'hi', profile: 'poplar' } });
    // A file the arm kept (fetch --out).
    arm.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'f1', method: 'arm/file', params: { name: 'a.txt', text: 'secret' } }));
    let file: any;
    for (let i = 0; i < 100 && !file; i++) {
      file = arm.received.find((m) => m.id === 'f1');
      await new Promise((r) => setTimeout(r, 10));
    }
    const filePath = new URL(file.result.url).pathname;
    expect((await hub(filePath, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await stubOf(user.uid).recentActivity()).toHaveLength(1);

    const csrf = csrfOf(await (await hub('/app/delete', { headers: { Cookie: cookie } })).text());
    const res = await form('/app/delete', cookie, { csrf });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<h1>✅ Your Cloud Bridge data is deleted</h1>');
    expect(html).toContain(`Cloud Bridge signed out 2 Chrome profiles and 1 AI app, and deleted what it kept for <strong>@${user.login}</strong>. You're signed out here too.`);
    expect(html).toContain('href="https://github.com/settings/applications"');
    expect(html).not.toContain("couldn't be listed");
    expect(plain(html)).not.toMatch(JARGON);
    expect(res.headers.getSetCookie().join('\n')).toMatch(/^cb_session=; .*Max-Age=0/m);

    expect(await arm.closed).toEqual({ code: 4401, reason: 'signed out of Cloud Bridge: the account was deleted' });
    expect((await (await connectArm(armToken, { kind: 'chrome', name: 'poplar' })).closed).code).toBe(4401);
    await expect(mcpClient(token)).rejects.toThrow();
    expect((await hub(filePath, { headers: { Cookie: cookie } })).status).toBe(404);
    expect(await env.OAUTH_KV.list({ prefix: `file:${user.uid}:` })).toMatchObject({ keys: [] });
    expect(await stubOf(user.uid).recentActivity()).toEqual([]);
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").toArray()).toEqual([]);
    });
    // Running it again (a retry after a failure part way) is fine.
    const again = await form('/app/delete', cookie, { csrf });
    expect(await again.text()).toContain('Cloud Bridge signed out 0 Chrome profiles and 0 AI apps');
  });

  it("a call still running when the data goes doesn't write it back", async () => {
    const { user, cookie } = await signedIn();
    const { arm } = await chrome(cookie, 'poplar', () => undefined); // never answers
    const stub = stubOf(user.uid);
    const call = stub.callTool('chrome_echo', { text: 'x' });
    for (let i = 0; i < 100 && !arm.received.some((m) => m.method === 'tools/call'); i++) await new Promise((r) => setTimeout(r, 10));
    await stub.deleteEverything(user.uid);
    const res = await call;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('the arm signed out of Cloud Bridge: the account was deleted before answering');
    await arm.closed;
    await new Promise((r) => setTimeout(r, 50)); // the socket's close reaches the hub too
    await runInDurableObject(stub, async (instance: UserHub, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('arms', 'activity', 'meta')").toArray()).toEqual([]);
      // A socket whose close reaches the hub only now: its "last seen" has nowhere to go, and must not throw.
      const late = { deserializeAttachment: () => ({ armId: 'gone-arm', connId: 'c1', ready: true }), close() {} } as unknown as WebSocket;
      await expect(instance.webSocketClose(late, 1006, '')).resolves.toBeUndefined();
      await expect(instance.webSocketError(late)).resolves.toBeUndefined();
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'arms'").toArray()).toEqual([]);
    });
  });
});
