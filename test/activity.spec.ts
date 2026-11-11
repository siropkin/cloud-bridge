import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_META, CATCH_UP_MAX, VIEWERS_MAX, type ActivityView, type UserHub } from '../src/hub';
import { ECHO, ORIGIN, accessToken, connectArm, cookieFor, hub, mcpClient, newUser, pairArm } from './helpers';

const stubOf = (uid: string) => env.USER_HUB.get(env.USER_HUB.idFromName(uid));
const plain = (html: string) =>
  html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ')
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace('Add custom MCP server', ' '); // ChatGPT's own menu words
const JARGON = /\barms?\b|\bhub\b|\bMCP\b|\bpair/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(onCall?: (p: any) => unknown) {
  const user = newUser();
  const cookie = await cookieFor(user);
  const { token } = await pairArm(cookie, 'fake', 'birch');
  const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: onCall ?? ((p) => ({ content: [{ type: 'text', text: p.arguments.text }] })) });
  await arm.ready;
  const client = await mcpClient(await accessToken(cookie));
  return { user, cookie, token, arm, client };
}

const rowsOf = async (cookie: string, before = 0) => (await (await hub(`/app/activity.json?before=${before}`, { headers: { Cookie: cookie } })).json()) as { rows: ActivityView[]; more: boolean };

interface Viewer {
  ws: WebSocket;
  frames: ActivityView[][];
  resets: number;
  closed: Promise<{ code: number; reason: string }>;
}
async function watch(cookie: string, after = 0): Promise<Viewer> {
  const res = await hub(`/app/activity/live?after=${after}`, { headers: { Upgrade: 'websocket', Cookie: cookie, Origin: ORIGIN } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status} ${await res.text()}`);
  ws.accept();
  const frames: ActivityView[][] = [];
  const viewer: Viewer = { ws, frames, resets: 0, closed: null! };
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data as string);
    if (m.reset) viewer.resets++;
    else frames.push(m.rows);
  });
  viewer.closed = new Promise<{ code: number; reason: string }>((r) => ws.addEventListener('close', (e) => r({ code: e.code, reason: e.reason })));
  return viewer;
}
async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = get();
    if (v !== undefined) return v;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Activity page', () => {
  it('asks a signed-out visitor to sign in first, and comes back here', async () => {
    const res = await hub('/app/activity', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/login?next=%2Fapp%2Factivity');
    expect((await hub('/app/activity.json')).status).toBe(401);
  });

  it('speaks plain words, runs only its own hashed script and may connect only to this site', async () => {
    const cookie = await cookieFor(newUser());
    const res = await hub('/app/activity', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(plain(html)).not.toMatch(JARGON);
    const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain(`script-src 'sha256-${btoa(String.fromCharCode(...digest))}'`);
    expect(csp).toContain(`connect-src 'self' ${ORIGIN.replace(/^http/, 'ws')}`);
    expect(csp).toContain("default-src 'none'");
    expect(code).not.toContain('${'); // String.raw kept it literal
  });

  it('lists a call with the app, the profile and how it went, newest first, in pages', async () => {
    const { cookie, client, arm } = await setup();
    for (const text of ['a', 'b', 'c']) await client.callTool({ name: 'fake_echo', arguments: { text } });
    const { rows, more } = await rowsOf(cookie);
    expect(more).toBe(false);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ tool: 'fake_echo', clientName: 'Test client', profile: 'birch', profileGone: 0, ok: 1, command: null, site: null, error: null });
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
    expect(JSON.stringify(rows)).not.toContain('"a"'); // never the arguments
    const older = await rowsOf(cookie, rows[1].id);
    expect(older.rows.map((r) => r.id)).toEqual([rows[2].id]);
    arm.ws.close();
  });

  it('pages through more rows than fit', async () => {
    const { user, client, arm } = await setup();
    for (let i = 0; i < 3; i++) await client.callTool({ name: 'fake_echo', arguments: { text: 'x' } });
    const first = await stubOf(user.uid).activityRows(0, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.more).toBe(true);
    const rest = await stubOf(user.uid).activityRows(first.rows[1].id, 2);
    expect(rest.rows).toHaveLength(1);
    expect(rest.more).toBe(false);
    arm.ws.close();
  });

  it("keeps the command word and site an arm reports, drops malformed ones, and never forwards _meta to the AI app", async () => {
    const reports: unknown[] = [
      { command: 'snap', site: 'GitHub.com' },
      { command: 'Snap!', site: 'evil.com/<script>' },
      { command: 'x'.repeat(40), site: 'localhost:8787' },
    ];
    let n = 0;
    const { cookie, client, arm } = await setup(() => ({ content: [{ type: 'text', text: 'ok' }], _meta: { [ACTIVITY_META]: reports[n++] } }));
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    expect(res._meta).toBeUndefined();
    await client.callTool({ name: 'fake_echo', arguments: { text: 'b' } });
    await client.callTool({ name: 'fake_echo', arguments: { text: 'c' } });
    const { rows } = await rowsOf(cookie);
    expect(rows.map((r) => [r.command, r.site])).toEqual([
      [null, 'localhost:8787'],
      [null, null],
      ['snap', 'github.com'],
    ]);
    arm.ws.close();
  });

  it("an arm's error stays unnamed, a hub refusal keeps its words, and a removed profile is said to be removed", async () => {
    const { user, cookie, client, arm } = await setup(() => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    const [failed] = (await rowsOf(cookie)).rows;
    expect(failed).toMatchObject({ ok: 0, error: null, profile: 'birch' });
    const [armId] = (await stubOf(user.uid).armDetails()).map((a) => a.id);
    await stubOf(user.uid).disconnectArm(armId);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'b' } });
    const [refused, gone] = (await rowsOf(cookie)).rows;
    expect(refused).toMatchObject({ ok: 0, profile: null, profileGone: 0 });
    expect(refused.error).toBeTruthy(); // the hub's own words to the AI app
    expect(gone).toMatchObject({ id: failed.id, profile: null, profileGone: 1 });
    arm.ws.close();
  });

  it('a hub made before the Activity page gets its new columns and keeps its old rows', async () => {
    const name = `gh-old-${crypto.randomUUID()}`;
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(name));
    await runInDurableObject(stub, (_: UserHub, state) => {
      state.storage.sql.exec(`CREATE TABLE arms(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version TEXT, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, last_seen INTEGER, tools TEXT, selector TEXT, offline_hint TEXT)`);
      state.storage.sql.exec(`CREATE TABLE activity(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, client TEXT, arm_id TEXT, command TEXT NOT NULL,
        target_host TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, result_ref TEXT)`);
      state.storage.sql.exec("INSERT INTO activity(ts, client, command, ok, ms) VALUES (1, 'c1', 'fake_echo', 1, 5)");
    });
    const { rows } = await stub.activityRows();
    expect(rows).toEqual([expect.objectContaining({ tool: 'fake_echo', client: 'c1', clientName: null, command: null })]);
    const cols = await runInDurableObject(stub, (_: UserHub, state) => state.storage.sql.exec<{ name: string }>('PRAGMA table_info(activity)').toArray().map((c) => c.name));
    expect(cols).toEqual(expect.arrayContaining(['verb', 'client_name']));
  });
});

describe('Activity, live', () => {
  it('sends each new row to an open page, and what it missed when it (re)connects', async () => {
    const { cookie, client, arm } = await setup();
    await client.callTool({ name: 'fake_echo', arguments: { text: 'before' } });
    const [first] = (await rowsOf(cookie)).rows;
    const page = await watch(cookie, first.id); // as the page does: after its newest row
    await client.callTool({ name: 'fake_echo', arguments: { text: 'live' } });
    const [row] = await until(() => page.frames[0], 'a live row');
    expect(row).toMatchObject({ tool: 'fake_echo', clientName: 'Test client', profile: 'birch', ok: 1 });
    expect(row.id).toBeGreaterThan(first.id);
    const late = await watch(cookie, first.id);
    const missed = await until(() => late.frames[0], 'the missed rows');
    expect(missed.map((r) => r.id)).toEqual([row.id]);
    page.ws.close();
    late.ws.close();
    arm.ws.close();
  });

  it('catches up a page that opened with no rows, and tells one that missed too many to reload', async () => {
    const { user, cookie, client, arm } = await setup();
    await client.callTool({ name: 'fake_echo', arguments: { text: 'between render and connect' } });
    const empty = await watch(cookie, 0);
    expect((await until(() => empty.frames[0], 'the row written before it connected')).map((r) => r.tool)).toEqual(['fake_echo']);
    const [{ id }] = (await rowsOf(cookie)).rows;
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      for (let i = 0; i <= CATCH_UP_MAX; i++) state.storage.sql.exec("INSERT INTO activity(ts, command, ok, ms) VALUES (?, 'fake_echo', 1, 1)", Date.now());
    });
    const behind = await watch(cookie, id);
    await until(() => (behind.resets ? true : undefined), 'a reset');
    expect(behind.frames).toEqual([]);
    empty.ws.close();
    behind.ws.close();
    arm.ws.close();
  });

  it("is a page, not an arm: it isn't listed, its messages do nothing, and its close touches no arm", async () => {
    const { user, cookie, client, arm } = await setup();
    const page = await watch(cookie);
    page.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/hello', params: { kind: 'fake', name: 'intruder', version: '1' } }));
    page.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    await sleep(30);
    expect(page.frames).toEqual([]); // no arm/policy, arm/name or tools/list sent to a page
    expect((await stubOf(user.uid).armDetails()).map((a) => [a.name, a.online])).toEqual([['birch', true]]);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'still a page' } });
    await until(() => page.frames[0], 'a live row after the stray messages');
    // A page closing runs the arms' close path: it must find nothing to do there.
    await runInDurableObject(stubOf(user.uid), async (hub: UserHub, state) => {
      const ws = state.getWebSockets('viewer')[0];
      await hub.webSocketClose(ws, 1000, 'page closed');
      await hub.webSocketError(ws);
    });
    page.ws.close();
    await sleep(30);
    const res = await client.callTool({ name: 'fake_echo', arguments: { text: 'still here' } });
    expect(res.isError).toBeFalsy();
    arm.ws.close();
  });

  it('opens only from this site, signed in, as a WebSocket', async () => {
    const cookie = await cookieFor(newUser());
    const up = { Upgrade: 'websocket', Cookie: cookie };
    expect((await hub('/app/activity/live', { headers: { Cookie: cookie, Origin: ORIGIN } })).status).toBe(426);
    expect((await hub('/app/activity/live', { headers: { ...up, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await hub('/app/activity/live', { headers: up })).status).toBe(403);
    expect((await hub('/app/activity/live', { headers: { Upgrade: 'websocket', Origin: ORIGIN } })).status).toBe(401);
  });

  it(`keeps at most ${VIEWERS_MAX} pages open: the oldest is told to reload`, async () => {
    const cookie = await cookieFor(newUser());
    const pages: Viewer[] = [];
    for (let i = 0; i <= VIEWERS_MAX; i++) {
      pages.push(await watch(cookie));
      await sleep(2);
    }
    expect((await pages[0].closed).code).toBe(4000);
    for (const p of pages) p.ws.close();
  });

  it('Delete my data closes open pages as signed out', async () => {
    const { user, cookie, arm } = await setup();
    const page = await watch(cookie);
    await stubOf(user.uid).deleteEverything(user.uid);
    expect((await page.closed).code).toBe(4401);
    await arm.closed;
  });
});

describe('the account page', () => {
  it('shows the latest steps live and links to all of them', async () => {
    const { cookie, client, arm } = await setup();
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    const res = await hub('/app', { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('Latest from AI apps');
    expect(html).toContain('href="/app/activity"');
    const data = JSON.parse(/<script type="application\/json" id="activity-data">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.mode).toBe('strip');
    expect(data.rows).toHaveLength(1);
    expect(Object.values(data.apps)).toContain('Test client');
    expect(res.headers.get('Content-Security-Policy')).toContain('connect-src');
    expect(plain(html)).not.toMatch(JARGON);
    arm.ws.close();
  });

  it('a row can never close the data block early', async () => {
    const { activityData } = await import('../src/activity');
    const html = activityData('full', [{ id: 1, ts: 1, client: '</script><script>alert(1)</script>', clientName: null, profile: null, profileGone: 0, tool: 't', command: null, site: null, ok: 1, ms: 1, error: null }], false, {});
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(/>([\s\S]*)<\/script>$/.exec(html)![1]).rows[0].client).toContain('</script>');
  });
});
