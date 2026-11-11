import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_META, CATCH_UP_MAX, DETAILS_CAP, DETAILS_MS, IMAGE_MAX, VIEWERS_MAX, type ActivityView, type UserHub } from '../src/hub';
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

  it("an arm's error stays unnamed, a refusal gets a plain note, and a removed profile is said to be removed", async () => {
    const { user, cookie, client, arm } = await setup(() => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    const [failed] = (await rowsOf(cookie)).rows;
    expect(failed).toMatchObject({ ok: 0, error: null, profile: 'birch' });
    const [armId] = (await stubOf(user.uid).armDetails()).map((a) => a.id);
    await stubOf(user.uid).disconnectArm(armId);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'b' } });
    const [refused, gone] = (await rowsOf(cookie)).rows;
    expect(refused).toMatchObject({ ok: 0, profile: null, profileGone: 0 });
    expect(refused.error).toBe("The AI app asked for a step that nothing you've connected offers."); // plain words, not the AI app's text
    expect(gone).toMatchObject({ id: failed.id, profile: null, profileGone: 1 });
    arm.ws.close();
  });

  it('says in plain words when a profile lost its connection or never answered (found live: the page read "the arm disconnected (1006 …)")', async () => {
    const { cookie, client, arm } = await setup(() => undefined); // never answers
    const timedOut = await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } }); // the test timeout is 500 ms
    expect(timedOut.isError).toBe(true);
    const pending = client.callTool({ name: 'fake_echo', arguments: { text: 'b' } });
    await until(() => (arm.received.filter((m) => m.method === 'tools/call').length === 2 ? true : undefined), 'the second call');
    arm.ws.close(1011, 'gone');
    expect((await pending).isError).toBe(true);
    const { rows } = await rowsOf(cookie);
    expect(rows.map((r) => r.error)).toEqual([
      'Fake “birch” lost its connection before answering, so it may or may not have done this step.',
      "Fake “birch” didn't answer in time, so it may or may not have done this step.",
    ]);
  });

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
    expect(data.rows[0].clientName).toBe('Test client');
    expect(data).not.toHaveProperty('apps'); // names ride the rows: no grant list to fall back on
    expect(res.headers.get('Content-Security-Policy')).toContain('connect-src');
    expect(plain(html)).not.toMatch(JARGON);
    arm.ws.close();
  });

  it('a row can never close the data block early', async () => {
    const { activityData } = await import('../src/activity');
    const html = activityData('full', [{ id: 1, ts: 1, client: '</script><script>alert(1)</script>', clientName: null, profile: null, profileGone: 0, tool: 't', command: null, site: null, ok: 1, ms: 1, error: null, details: 0 }], false);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(/>([\s\S]*)<\/script>$/.exec(html)![1]).rows[0].client).toContain('</script>');
  });
});

// Keep details for 24 hours (D2b2): the arm's line + preview and the result's first image.
const form = (path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  hub(path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: new URLSearchParams(fields) });
const pageHtml = async (cookie: string, query = '') => (await hub(`/app/activity${query}`, { headers: { Cookie: cookie } })).text();
const csrfOn = async (cookie: string) => /name="csrf" value="([^"]+)"/.exec(await pageHtml(cookie))![1];
const keep = async (cookie: string, on: boolean) => form('/app/activity/keep', cookie, { csrf: await csrfOn(cookie), on: on ? '1' : '0' });
const PNG = btoa('\x89PNG fake bytes');
const details = async (cookie: string, id: number) => hub(`/app/activity/details?id=${id}`, { headers: { Cookie: cookie } });
// What chrome-bridge 1.34.7 sends: the redacted line and its own preview.
const reporting = (line: string, preview: string, extra: unknown[] = []) => () => ({
  content: [{ type: 'text', text: `$ ${line.replace('"***"', 'hunter2')}\nfilled hunter2` }, ...extra],
  _meta: { [ACTIVITY_META]: { command: 'fill', site: 'shop.test', line, preview } },
});

describe('Keep details for 24 hours', () => {
  it('is off by default: nothing beyond the step is kept, and the page offers it in plain words', async () => {
    const { cookie, client, arm } = await setup(reporting('# secret · fill shop.test @e5 -- "***"', 'changed: textbox', [{ type: 'image', data: PNG, mimeType: 'image/png' }]));
    await client.callTool({ name: 'fake_echo', arguments: { text: 'hunter2' } });
    const [row] = (await rowsOf(cookie)).rows;
    expect(row.details).toBe(0);
    expect((await details(cookie, row.id)).status).toBe(404);
    const html = await pageHtml(cookie);
    expect(html).toContain('Keep details for 24 hours');
    expect(plain(html)).not.toMatch(JARGON);
    arm.ws.close();
  });

  it("keeps the arm's line, its preview and a screenshot, never the AI app's arguments or the raw result; off deletes them at once", async () => {
    const { user, cookie, client, arm } = await setup(reporting('# secret · fill shop.test @e5 -- "***"', "(its answer isn't kept: it can show what was typed)", [{ type: 'image', data: PNG, mimeType: 'image/png' }]));
    const on = await keep(cookie, true);
    expect(on.status).toBe(303);
    expect(on.headers.get('Location')).toBe(`${ORIGIN}/app/activity?done=keeping`);
    const html = await pageHtml(cookie, '?done=keeping');
    expect(html).toContain('Cloud Bridge keeps details of new steps for 24 hours from now on.');
    expect(html).toContain('Stop keeping details');
    expect(plain(html)).not.toMatch(JARGON);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'hunter2' } });
    const [row] = (await rowsOf(cookie)).rows;
    expect(row.details).toBe(1);
    const got = await (await details(cookie, row.id)).json();
    expect(got).toEqual({ line: '# secret · fill shop.test @e5 -- "***"', preview: "(its answer isn't kept: it can show what was typed)", image: true, imageTooBig: false });
    const stored = await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => JSON.stringify(state.storage.sql.exec('SELECT line, preview FROM details').toArray()));
    expect(stored).not.toContain('hunter2');
    const img = await hub(`/app/activity/image?id=${row.id}`, { headers: { Cookie: cookie } });
    expect(img.headers.get('Content-Type')).toBe('image/png');
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(img.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([...'\x89PNG fake bytes'].map((c) => c.charCodeAt(0)));
    // Another account can't read them.
    const other = await cookieFor(newUser());
    expect((await details(other, row.id)).status).toBe(404);
    expect((await hub(`/app/activity/image?id=${row.id}`, { headers: { Cookie: other } })).status).toBe(404);
    const off = await keep(cookie, false);
    expect(off.headers.get('Location')).toBe(`${ORIGIN}/app/activity?done=cleared`);
    expect((await details(cookie, row.id)).status).toBe(404);
    expect((await rowsOf(cookie)).rows[0].details).toBe(0);
    expect(await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM details').one().n)).toBe(0);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'after' } });
    expect((await rowsOf(cookie)).rows[0].details).toBe(0);
    arm.ws.close();
  });

  it('keeps only image types a browser shows as images, and says when a screenshot was too big', async () => {
    const shots = [
      { type: 'image', data: btoa('<svg onload=alert(1)>'), mimeType: 'image/svg+xml' },
      { type: 'image', data: btoa('x'.repeat(IMAGE_MAX + 10)), mimeType: 'image/jpeg' },
    ];
    let n = 0;
    const { cookie, client, arm } = await setup(() => ({ content: [shots[n++]], _meta: { [ACTIVITY_META]: { command: 'shot', line: 'shot a.test shot.png' } } }));
    await keep(cookie, true);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    await client.callTool({ name: 'fake_echo', arguments: { text: 'b' } });
    const [big, svg] = (await rowsOf(cookie)).rows;
    expect(await (await details(cookie, svg.id)).json()).toMatchObject({ image: false, imageTooBig: false });
    expect(await (await details(cookie, big.id)).json()).toMatchObject({ image: false, imageTooBig: true });
    expect((await hub(`/app/activity/image?id=${svg.id}`, { headers: { Cookie: cookie } })).status).toBe(404);
    arm.ws.close();
  });

  it(`past ${DETAILS_CAP / 1048576} MB the oldest details make room, and their steps say so`, async () => {
    const { user, cookie, client, arm } = await setup(reporting('snap a.test', 'ok'));
    await keep(cookie, true);
    for (const t of ['old', 'mid', 'new']) await client.callTool({ name: 'fake_echo', arguments: { text: t } });
    const [newest, mid, old] = (await rowsOf(cookie)).rows;
    // As if the two older ones held a big screenshot each.
    await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => {
      state.storage.sql.exec('UPDATE details SET bytes = ? WHERE activity_id IN (?, ?)', DETAILS_CAP / 2, old.id, mid.id);
      state.storage.sql.exec("UPDATE settings SET json = (SELECT SUM(bytes) FROM details) WHERE key = 'details_bytes'");
    });
    await client.callTool({ name: 'fake_echo', arguments: { text: 'one more' } });
    const rows = (await rowsOf(cookie)).rows;
    expect(rows.map((r) => [r.id, r.details])).toEqual([
      [rows[0].id, 1],
      [newest.id, 1],
      [mid.id, 1],
      [old.id, 2],
    ]);
    expect((await details(cookie, old.id)).status).toBe(404);
    arm.ws.close();
  });

  it('details last 24 hours, swept by an alarm even when no call comes', async () => {
    const { user, cookie, client, arm } = await setup(reporting('snap a.test', 'ok'));
    await keep(cookie, true);
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    const stub = stubOf(user.uid);
    const alarm = await runInDurableObject(stub, (_: UserHub, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + DETAILS_MS - 60_000);
    const [row] = (await rowsOf(cookie)).rows;
    await runInDurableObject(stub, async (instance: UserHub, state) => {
      state.storage.sql.exec('UPDATE details SET ts = ?', Date.now() - DETAILS_MS - 1);
      expect(await instance.stepDetails(row.id)).toBeNull(); // read as gone at once
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM details').one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT json FROM settings WHERE key = 'details_bytes'").one().json).toBe('0');
    });
    expect((await rowsOf(cookie)).rows[0].details).toBe(0);
    arm.ws.close();
  });

  it('the sweep runs at most hourly and reads only what it deletes (an alarm per kept step scanned the whole table each time)', async () => {
    const { user, cookie, client, arm } = await setup(reporting('snap a.test', 'ok'));
    await keep(cookie, true);
    for (let i = 0; i < 3; i++) await client.callTool({ name: 'fake_echo', arguments: { text: String(i) } });
    const stub = stubOf(user.uid);
    await runInDurableObject(stub, async (instance: UserHub, state) => {
      const now = Date.now();
      const ids = state.storage.sql.exec<{ id: number }>('SELECT activity_id AS id FROM details ORDER BY activity_id').toArray().map((r) => r.id);
      // The two older ones expired; the newest was kept 23 hours ago.
      state.storage.sql.exec('UPDATE details SET ts = ? WHERE activity_id IN (?, ?)', now - DETAILS_MS - 1, ids[0], ids[1]);
      state.storage.sql.exec('UPDATE details SET ts = ? WHERE activity_id = ?', now - 23 * 3600_000, ids[2]);
      await instance.alarm();
      expect(state.storage.sql.exec<{ id: number }>('SELECT activity_id AS id FROM details').toArray().map((r) => r.id)).toEqual([ids[2]]);
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm % 3600_000).toBe(0); // on the hour, so one run clears a batch
      expect(alarm).toBeGreaterThanOrEqual(now + 3600_000 - 1000);
      expect(alarm).toBeLessThanOrEqual(now + 2 * 3600_000);
      const left = state.storage.sql.exec<{ n: number }>('SELECT SUM(bytes) AS n FROM details').one().n;
      expect(state.storage.sql.exec("SELECT json FROM settings WHERE key = 'details_bytes'").one().json).toBe(String(left));
    });
    arm.ws.close();
  });

  it('downloads a group as a script: kept lines oldest first, every other step a comment', async () => {
    const lines = ['open https://a.test/', null, 'snap a.test'];
    let n = 0;
    const { cookie, client, arm } = await setup(() => {
      const line = lines[n++];
      return { content: [{ type: 'text', text: 'ok' }], _meta: { [ACTIVITY_META]: line ? { command: line.split(' ')[0], site: 'a.test', line } : { command: 'tabs' } } };
    });
    await keep(cookie, true);
    for (let i = 0; i < 3; i++) await client.callTool({ name: 'fake_echo', arguments: { text: 'x' } });
    const ids = (await rowsOf(cookie)).rows.map((r) => r.id);
    const res = await hub(`/app/activity/script?ids=${[...ids].reverse().join(',')},999999,abc`, { headers: { Cookie: cookie } });
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const body = await res.text();
    const [, , , ...steps] = body.trimEnd().split('\n');
    expect(steps[0]).toBe('open https://a.test/');
    expect(steps[1]).toMatch(/^# \d{4}-\d\d-\d\dT[\d:.]+Z tabs: details not kept$/);
    expect(steps[2]).toBe('snap a.test');
    expect(body).toContain('3 steps, 2 with their commands');
    expect(body).toContain('node cli.mjs batch < steps.txt');
    const many = await (await hub(`/app/activity/script?ids=${Array.from({ length: 502 }, (_, i) => i + 1).join(',')}`, { headers: { Cookie: cookie } })).text();
    expect(many.split('\n')[0]).toBe('# Only the first 500 of the 502 steps asked for: a script holds at most 500.');
    // Someone else's ids give them nothing.
    const other = await (await hub(`/app/activity/script?ids=${ids.join(',')}`, { headers: { Cookie: await cookieFor(newUser()) } })).text();
    expect(other).toContain('0 steps');
    arm.ws.close();
  });

  it('the switch takes only this account\'s own page: a stale token or another site changes nothing', async () => {
    const { user, cookie } = await (async () => {
      const u = newUser();
      return { user: u, cookie: await cookieFor(u) };
    })();
    const csrf = await csrfOn(cookie);
    const stale = await form('/app/activity/keep', cookie, { csrf: 'nope', on: '1' });
    expect(stale.headers.get('Location')).toBe(`${ORIGIN}/app/activity?error=stale`);
    const cross = await form('/app/activity/keep', cookie, { csrf, on: '1' }, { 'Sec-Fetch-Site': 'cross-site' });
    expect(cross.headers.get('Location')).toBe(`${ORIGIN}/app/activity?error=stale`);
    expect(await stubOf(user.uid).keepingDetails()).toBe(false);
    const out = await hub('/app/activity/keep', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'on=1' });
    expect(out.headers.get('Location')).toBe(`${ORIGIN}/login?next=/app/activity`);
  });
});

describe('activity upkeep', () => {
  it('trimming old steps reads a few rows per call, not the whole history (it read all 5,000 on every call)', async () => {
    const { user, client, arm } = await setup();
    await client.callTool({ name: 'fake_echo', arguments: { text: 'a' } });
    const read = await runInDurableObject(stubOf(user.uid), (instance: UserHub, state) => {
      const now = Date.now();
      state.storage.sql.exec("UPDATE activity SET ts = ?, command = 'old'", now - 31 * 86400_000); // the first call's row, 31 days back
      for (let i = 0; i < 3000; i++) state.storage.sql.exec("INSERT INTO activity(ts, command, ok, ms) VALUES (?, 'fake_echo', 1, 1)", now);
      return instance.prune(now);
    });
    expect(read).toBeLessThan(20);
    const commands = await runInDurableObject(stubOf(user.uid), (_: UserHub, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE command = 'old'").one().n);
    expect(commands).toBe(0); // the 31-day-old step went; the order of ids is the order of time
    arm.ws.close();
  });
});
