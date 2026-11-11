import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { validRegistry, type UserHub } from '../src/hub';
import { parseBlocked, siteOf } from '../src/settings';
import { ORIGIN, accessToken, connectArm, cookieFor, hub, mcpClient, newUser, pairArm, type TestArm } from './helpers';

// People never read "arm", "hub", "pair" or "MCP" here (D3a, decision d3-design).
const plain = (html: string) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
const JARGON = /\barms?\b|\bhub\b|\bMCP\b|\bpair/i;

const TOOL = (name: string) => ({ name, inputSchema: { type: 'object', properties: { tab: { type: 'string' } } } });
const TOOLS = [TOOL('chrome'), TOOL('chrome_snap'), TOOL('chrome_click')];
// What chrome-bridge sends in arm/hello: each command in people's words with the typed tools that run it.
const REGISTRY = [
  { name: 'tabs', group: 'Reading pages', title: 'See your open tabs', tools: [] },
  { name: 'snap', group: 'Reading pages', title: "Read a page's text and controls", tools: ['chrome_snap'] },
  { name: 'click', group: 'Acting on pages', title: 'Click', tools: ['chrome_click'] },
  { name: 'eval', group: 'Running code in pages', title: 'Run its own code in a page, including while waiting', tools: [] },
];

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1];
const form = (cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  hub('/app/settings', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: new URLSearchParams(fields) });
const settingsHtml = async (cookie: string, query = '') => (await hub(`/app/settings${query}`, { headers: { Cookie: cookie } })).text();
const stubOf = (uid: string) => env.USER_HUB.get(env.USER_HUB.idFromName(uid));
const policies = (arm: TestArm) => arm.received.filter((m) => m.method === 'arm/policy').map((m) => m.params);
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function signedIn() {
  const user = newUser();
  return { user, cookie: await cookieFor(user) };
}

async function chrome(cookie: string, name: string, instanceId: string, calls: any[] = []) {
  const { token } = await pairArm(cookie, 'chrome', name);
  const arm = await connectArm(token, { kind: 'chrome', name, selector: 'profile', tools: TOOLS, registry: REGISTRY, instanceId, onCall: (p) => (calls.push(p), { content: [{ type: 'text', text: 'ok' }] }) });
  await arm.ready;
  return { token, arm };
}

const idOf = async (uid: string, name: string) => (await stubOf(uid).armDetails()).find((a) => a.name === name)!.id;

describe('the settings page (/app/settings)', () => {
  it('signs you in first; with nothing connected it says how to connect one, in plain words', async () => {
    const res = await hub('/app/settings', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/login?next=%2Fapp%2Fsettings`);
    const { cookie } = await signedIn();
    const html = await settingsHtml(cookie);
    expect(html).toContain('<title>What AI apps may do in your Chrome · Cloud Bridge</title>');
    expect(html).toContain('No Chrome is connected yet.');
    expect(html).not.toContain('<form');
    expect(plain(html)).not.toMatch(JARGON);
  });

  it("lists what the profile said it can do, by group, everything allowed until changed; its first policy names this page", async () => {
    const { user, cookie } = await signedIn();
    const { arm } = await chrome(cookie, 'poplar', 'inst-poplar-0001');
    const id = await idOf(user.uid, 'poplar');
    expect(policies(arm)).toEqual([{ commands: {}, blockedDomains: [], settingsUrl: `${ORIGIN}/app/settings?profile=${id}` }]);
    const html = await settingsHtml(cookie);
    expect(html).toContain('<h2>Chrome profile “poplar”</h2>');
    expect(html.match(/<section><h2>([^<]+)<\/h2>/g)).toEqual(['<section><h2>Reading pages</h2>', '<section><h2>Acting on pages</h2>', '<section><h2>Running code in pages</h2>', "<section><h2>Websites AI apps can't use</h2>"]);
    expect(html).toContain('<span>Read a page&#39;s text and controls<span class="word">snap</span></span>');
    expect(html).toContain('<input type="radio" name="c:snap" value="allow" checked> Allow');
    expect(html).toContain('<input type="radio" name="c:snap" value="off"> Off');
    expect(html).not.toMatch(/value="off" checked/);
    expect(plain(html)).not.toMatch(JARGON);
    expect(await (await hub('/app', { headers: { Cookie: cookie } })).text()).toContain('<a href="/app/settings">Choose what AI apps may do in each Chrome profile →</a>');
    arm.ws.close();
  });

  it('Off: the profile hears it at once, AI apps lose its typed tool, and a cached call is refused here with where to change it', async () => {
    const { user, cookie } = await signedIn();
    const calls: any[] = [];
    const { arm } = await chrome(cookie, 'poplar', 'inst-poplar-0002', calls);
    const id = await idOf(user.uid, 'poplar');
    const settingsUrl = `${ORIGIN}/app/settings?profile=${id}`;
    const csrf = csrfOf(await settingsHtml(cookie));
    const res = await form(cookie, { csrf, profile: id, 'c:snap': 'off', 'c:click': 'allow', blocked: 'https://www.Chase.com/login\n*.mail.example.org\nnot a website\n\nchase.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app/settings?profile=${id}&done=saved&skipped=1`);
    await until(() => policies(arm).length === 2);
    expect(policies(arm)[1]).toEqual({ commands: { snap: 'off' }, blockedDomains: ['chase.com', 'mail.example.org'], settingsUrl });
    const html = await settingsHtml(cookie, `?profile=${id}&done=saved&skipped=1`);
    expect(html).toContain("<p class=\"ok\">Saved. AI apps follow these rules from their next step in this Chrome profile. 1 line wasn't a website address, so it was left out.</p>");
    expect(html).toContain('<input type="radio" name="c:snap" value="off" checked> Off');
    expect(html).toContain('>chase.com\nmail.example.org</textarea>');

    const client = await mcpClient(await accessToken(cookie));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['chrome', 'chrome_click']);
    const refused = await client.callTool({ name: 'chrome_snap', arguments: { tab: 'github' } });
    expect(refused.isError).toBe(true);
    expect((refused.content as any)[0].text).toBe(`snap is turned off for the chrome "poplar" in the user's Cloud Bridge settings, so nothing ran. Do the task without it, or ask the user to allow it there (${settingsUrl}).`);
    expect(calls).toEqual([]);
    const [row] = (await stubOf(user.uid).activityRows(0, 1)).rows;
    expect(row).toMatchObject({ profile: 'poplar', tool: 'chrome_snap', command: 'snap', ok: 0, error: "The AI app tried to “Read a page's text and controls”, which you turned off for Chrome profile “poplar”." });
    expect(row.error).not.toMatch(JARGON);
    // Other tools and the line tool still reach the profile (it refuses an Off line itself).
    expect((await client.callTool({ name: 'chrome_click', arguments: { tab: 'github' } })).isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual(['chrome_click']);

    // Back to Allow with nothing blocked: nothing kept, the tool comes back.
    await form(cookie, { csrf, profile: id, 'c:snap': 'allow', blocked: '' });
    await until(() => policies(arm).length === 3);
    expect(policies(arm)[2]).toEqual({ commands: {}, blockedDomains: [], settingsUrl });
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      expect(state.storage.sql.exec("SELECT key FROM settings WHERE key GLOB 'rules:*'").toArray()).toEqual([]);
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['chrome', 'chrome_snap', 'chrome_click']);
    arm.ws.close();
  });

  it('rules belong to the Chrome profile: they survive turning Cloud AI apps off and on, and another profile keeps its own', async () => {
    const { user, cookie } = await signedIn();
    const first = await chrome(cookie, 'poplar', 'inst-poplar-0003');
    const hazelCalls: any[] = [];
    const hazel = await chrome(cookie, 'hazel', 'inst-hazel-0003', hazelCalls);
    const poplarId = await idOf(user.uid, 'poplar');
    const hazelId = await idOf(user.uid, 'hazel');
    const csrf = csrfOf(await settingsHtml(cookie, `?profile=${poplarId}`));
    await form(cookie, { csrf, profile: poplarId, 'c:snap': 'off', blocked: 'bank.example' });
    await until(() => policies(first.arm).length === 2);
    expect(policies(hazel.arm)).toHaveLength(1);
    expect(policies(hazel.arm)[0]).toMatchObject({ commands: {}, blockedDomains: [] });
    // The page switches between profiles.
    const page = await settingsHtml(cookie, `?profile=${hazelId}`);
    expect(page).toContain('<h2>Chrome profile “hazel”</h2>');
    expect(page).toContain(`<a href="/app/settings?profile=${poplarId}">poplar</a>`);
    expect(page).toContain('<strong>hazel</strong>');

    // One profile Off, the other allowed: the tool stays listed, and the refusal names who allows it.
    const client = await mcpClient(await accessToken(cookie));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('chrome_snap');
    const refused = await client.callTool({ name: 'chrome_snap', arguments: { tab: 'x', profile: 'poplar' } });
    expect((refused.content as any)[0].text).toMatch(/^snap is turned off for the chrome "poplar" in the user's Cloud Bridge settings, so nothing ran\. hazel allows it: pass profile as that name, or do the task without it/);
    expect((await client.callTool({ name: 'chrome_snap', arguments: { tab: 'x', profile: 'hazel' } })).isError).toBeFalsy();
    expect(hazelCalls).toHaveLength(1);

    // Disconnected on /app, then connected again from the popup: a new record, the same profile.
    const appCsrf = csrfOf(await (await hub('/app', { headers: { Cookie: cookie } })).text());
    await hub('/app/disconnect', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams({ csrf: appCsrf, id: poplarId }) });
    expect((await first.arm.closed).code).toBe(4401);
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      expect(state.storage.sql.exec('SELECT key FROM settings WHERE key = ?', `arm:${poplarId}`).toArray()).toEqual([]);
    });
    const again = await chrome(cookie, 'poplar', 'inst-poplar-0003');
    const newId = await idOf(user.uid, 'poplar');
    expect(newId).not.toBe(poplarId);
    expect(policies(again.arm)).toEqual([{ commands: { snap: 'off' }, blockedDomains: ['bank.example'], settingsUrl: `${ORIGIN}/app/settings?profile=${newId}` }]);
    again.arm.ws.close();
    hazel.arm.ws.close();
  });

  it('keeps only commands the profile listed, only Allow or Off; a forged form or another account changes nothing', async () => {
    const { user, cookie } = await signedIn();
    const { arm } = await chrome(cookie, 'poplar', 'inst-poplar-0004');
    const id = await idOf(user.uid, 'poplar');
    const csrf = csrfOf(await settingsHtml(cookie));
    await form(cookie, { csrf, profile: id, 'c:nope': 'off', 'c:click': 'sometimes', 'c:__proto__': 'off', 'c:eval': 'off' });
    await until(() => policies(arm).length === 2);
    expect(policies(arm)[1].commands).toEqual({ eval: 'off' });
    // No token, or posted from another site: refused before anything is read.
    for (const [fields, headers] of [[{ profile: id, 'c:snap': 'off' }, {}], [{ csrf, profile: id, 'c:snap': 'off' }, { 'Sec-Fetch-Site': 'cross-site' }]] as const) {
      const res = await form(cookie, fields, headers);
      expect(res.headers.get('Location')).toBe(`${ORIGIN}/app/settings?error=stale`);
    }
    // Another account with its own token names this account's profile: not theirs.
    const other = await signedIn();
    const otherCsrf = csrfOf(await (await hub('/app/delete', { headers: { Cookie: other.cookie } })).text());
    const res = await form(other.cookie, { csrf: otherCsrf, profile: id, 'c:snap': 'off' });
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app/settings?error=gone`);
    await new Promise((r) => setTimeout(r, 30));
    expect(policies(arm)).toHaveLength(2);
    expect(await settingsHtml(cookie, '?error=gone')).toContain('<p class="warn">That Chrome profile was disconnected, so nothing changed.</p>');
    arm.ws.close();
  });

  it("a profile that can't say what it can do gets no rules: it couldn't enforce them, and they'd be lost when it updates (review)", async () => {
    const { user, cookie } = await signedIn();
    // An older chrome-bridge: no registry, no stable id.
    const { token } = await pairArm(cookie, 'chrome', 'birch');
    const old = await connectArm(token, { kind: 'chrome', name: 'birch', selector: 'profile', tools: TOOLS });
    await old.ready;
    const id = await idOf(user.uid, 'birch');
    const html = await settingsHtml(cookie);
    expect(html).toContain("This Chrome profile hasn't told Cloud Bridge what it can do, so there's nothing to set for it yet. chrome-bridge 1.35 or later does that each time it connects: update chrome-bridge, then reload this page.");
    expect(html).not.toContain('<form');
    expect(plain(html)).not.toMatch(JARGON);
    const csrf = csrfOf(await (await hub('/app/delete', { headers: { Cookie: cookie } })).text());
    const res = await form(cookie, { csrf, profile: id, blocked: 'bank.example' });
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/app/settings?error=gone`);
    expect(policies(old)).toEqual([{ commands: {}, blockedDomains: [], settingsUrl: `${ORIGIN}/app/settings?profile=${id}` }]);
    // A registry without a stable id is no better: rules saved for it would vanish on its next pairing.
    old.ws.close();
    const noId = await connectArm(token, { kind: 'chrome', name: 'birch', selector: 'profile', tools: TOOLS, registry: REGISTRY });
    await noId.ready;
    expect(await settingsHtml(cookie)).not.toContain('<form');
    expect((await form(cookie, { csrf, profile: id, 'c:snap': 'off' })).headers.get('Location')).toBe(`${ORIGIN}/app/settings?error=gone`);
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      expect(state.storage.sql.exec("SELECT key FROM settings WHERE key GLOB 'rules:*'").toArray()).toEqual([]);
    });
    noId.ws.close();
  });
});

describe('blocked websites as typed', () => {
  it('reduces each line to the website it names, subdomains included', () => {
    expect(['chase.com', 'https://www.Chase.com/login?x=1', 'http://chase.com:8080', '*.chase.com', 'CHASE.COM.', 'user@chase.com'].map(siteOf)).toEqual(Array(6).fill('chase.com'));
    expect(siteOf('mail.google.com')).toBe('mail.google.com');
    expect(siteOf('xn--bcher-kva.de')).toBe('xn--bcher-kva.de');
    expect(siteOf('bücher.de')).toBe('xn--bcher-kva.de');
    for (const bad of ['', 'localhost', 'not a website', 'file:///etc/passwd', 'javascript:alert(1)', '[::1]', 'ftp://x.example', 'a'.repeat(250) + '.com']) expect(siteOf(bad), bad).toBeNull();
  });
  it('keeps each once, at most 200, and counts what it left out', () => {
    expect(parseBlocked('chase.com\n\nwww.chase.com\r\nnope\nbank.example')).toEqual({ sites: ['chase.com', 'bank.example'], skipped: 1 });
    const many = parseBlocked(Array.from({ length: 205 }, (_, i) => `site${i}.example`).join('\n'));
    expect([many.sites.length, many.skipped]).toEqual([200, 5]);
  });
});

describe('the registry an arm sends', () => {
  it('keeps well-formed entries only, capped, and never lets an entry name an odd command', () => {
    expect(validRegistry('x')).toEqual([]);
    expect(
      validRegistry([
        { name: 'snap', group: 'Reading pages', title: 'Read', tools: ['chrome_snap', 7, ''] },
        { name: 'snap', group: 'dup', title: 'dup', tools: [] },
        { name: 'Bad Name', title: 'x' },
        { name: '<script>', title: 'x' },
        { name: 'eval' },
        null,
      ]),
    ).toEqual([
      { name: 'snap', group: 'Reading pages', title: 'Read', tools: ['chrome_snap'] },
      { name: 'eval', group: 'Other', title: 'eval', tools: [] },
    ]);
    expect(validRegistry(Array.from({ length: 150 }, (_, i) => ({ name: `c${i}` })))).toHaveLength(100);
  });
});
