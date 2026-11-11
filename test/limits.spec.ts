import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserHub } from '../src/hub';
import {
  ARM_CONNECTS_PER_HOUR,
  CALLS_PER_DAY,
  CALLS_PER_MINUTE,
  FILES_PER_DAY_ALL,
  LIMITED,
  RETRY_AFTER_S,
  armConnectsText,
  callsPerDayText,
  callsPerMinuteText,
  filesTodayText,
  inAbout,
  limitAnonymous,
  network,
} from '../src/limits';
import { QUOTA_OBJECT } from '../src/store';
import { connectArm, cookieFor, ECHO, hub, newUser, pairArm } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text).join('\n');
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ');

// Miniflare's limiter counts in windows aligned to the clock: start a flood
// well inside one, or a rollover mid-test resets the count.
// A test that calls it can wait up to 8 s here, past vitest's 5 s default:
// give it WINDOW_TIMEOUT (a run landing in a minute's last seconds timed out).
async function windowStart(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 8000) await sleep(left + 50);
}
const WINDOW_TIMEOUT = 20_000;

let ips = 0;
const freshIp = () => `198.51.100.${++ips}`;
const from = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), 'CF-Connecting-IP': ip } });

describe('per-network limits on the routes anyone can call', () => {
  it('counts an IPv6 /64 as one network and an address ending in IPv4 as that IPv4', () => {
    expect(network('203.0.113.7')).toBe('203.0.113.7');
    expect(network('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(network('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(network('2001:DB8:AA:BB::9')).toBe('2001:db8:aa:bb::/64');
    expect(network('2001:db8:00aa:00bb:ffff::1')).toBe('2001:db8:aa:bb::/64');
    expect(network('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(network('2001:db8::1')).toBe(network('2001:db8:0:0:ffff::2'));
    expect(network('2001:db8:0:1::1')).not.toBe(network('2001:db8:0:2::1'));
    expect(network('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  const json = { 'Content-Type': 'application/json' };
  const routes: { name: string; limit: number; send: (ip: string) => Promise<Response>; check: (res: Response) => Promise<void> }[] = [
    {
      name: 'POST /register (OAuth error, the library never runs)',
      limit: 10,
      send: (ip) => hub('/register', from(ip, { method: 'POST', headers: json, body: '{}' })),
      check: async (res) => expect(await res.json()).toEqual(LIMITED.register),
    },
    ...['/authorize?client_id=x', '/login', '/callback?state=w.x'].map((path) => ({
      name: `GET ${path} (a page for a person)`,
      limit: 10,
      send: (ip: string) => hub(path, from(ip, { redirect: 'manual' })),
      check: async (res: Response) => {
        const html = await res.text();
        expect(res.headers.get('Content-Type')).toContain('text/html');
        expect(html).toContain('Too many tries');
        expect(plain(html)).toContain('Wait a minute, then try again.');
        expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b|\bpair/i);
      },
    })),
    {
      name: 'POST /pair/start (the popup shows the message)',
      limit: 10,
      send: (ip) => hub('/pair/start', from(ip, { method: 'POST', headers: json, body: '{"kind":"chrome","name":"oak"}' })),
      check: async (res) => expect(await res.json()).toEqual(LIMITED.pairStart),
    },
    {
      name: "POST /pair/poll (RFC 8628 slow_down: the code isn't lost)",
      limit: 60,
      send: (ip) => hub('/pair/poll', from(ip, { method: 'POST', headers: json, body: '{"code":"ABCD-EFGH","pollToken":"x"}' })),
      check: async (res) => expect(await res.json()).toEqual(LIMITED.pairPoll),
    },
    {
      name: 'POST /arm/revoke',
      limit: 60,
      send: (ip) => hub('/arm/revoke', from(ip, { method: 'POST', headers: { Authorization: 'Bearer nope' } })),
      check: async (res) => expect(await res.json()).toEqual(LIMITED.armRevoke),
    },
    {
      name: '/arm (a refused handshake, so browsers back off instead of redialing at once)',
      limit: 60,
      send: (ip) => hub('/arm', from(ip, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'cloud-bridge.v1, cbtoken.garbage' } })),
      check: async (res) => {
        expect(res.webSocket).toBeNull();
        expect(await res.text()).toBe(LIMITED.arm);
      },
    },
    // The account page: signed in, but each view lists grants and every change writes.
    ...([['GET /app', 60, '/app', 'GET'], ['POST /app/rename', 60, '/app/rename', 'POST'], ['POST /app/disconnect', 60, '/app/disconnect', 'POST'], ['POST /app/forget', 60, '/app/forget', 'POST'], ['POST /app/delete', 10, '/app/delete', 'POST']] as const).map(([name, limit, path, method]) => ({
      name: `${name} (the account page; nothing changes)`,
      limit,
      send: (ip: string) => hub(path, from(ip, { method, redirect: 'manual', ...(method === 'POST' ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=x' } : {}) })),
      check: async (res: Response) => {
        const html = await res.text();
        expect(html).toContain('Too many tries');
        expect(plain(html)).toContain('Nothing changed.');
        expect(html).toContain('<a href="/app">open your Cloud Bridge page</a>');
        expect(plain(html)).not.toMatch(/\barms?\b|\bhub\b|\bMCP\b|\bpair/i);
      },
    })),
  ];

  for (const route of routes) {
    it(`${route.name}: ${route.limit} a minute per network, then 429 with the next step`, async () => {
      await windowStart();
      const ip = freshIp();
      for (let i = 0; i < route.limit; i++) {
        const res = await route.send(ip);
        expect(res.status, `request ${i + 1}`).not.toBe(429);
        res.webSocket?.accept();
        res.webSocket?.close();
      }
      const res = await route.send(ip);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe(String(RETRY_AFTER_S));
      await route.check(res);
      // Another network isn't affected.
      expect((await route.send(freshIp())).status).not.toBe(429);
    }, WINDOW_TIMEOUT);
  }

  it('the routes count separately, and hosts in one IPv6 /64 share a count', async () => {
    await windowStart();
    const start = (ip: string) => hub('/pair/start', from(ip, { method: 'POST', headers: json, body: '{"kind":"chrome","name":"oak"}' }));
    for (let i = 0; i < 10; i++) expect((await start(`2001:db8:5:${ips}::${i + 1}`)).status).toBe(200);
    expect((await start(`2001:db8:5:${ips}:ffff::9`)).status).toBe(429);
    expect((await hub('/login', from(`2001:db8:5:${ips}::1`, { redirect: 'manual' }))).status).toBe(302);
  }, WINDOW_TIMEOUT);

  it("doesn't count requests that didn't come through Cloudflare's edge (no CF-Connecting-IP: tests, in-process)", async () => {
    for (let i = 0; i < 12; i++) expect((await hub('/pair/start', { method: 'POST', headers: json, body: '{"kind":"chrome","name":"oak"}' })).status).toBe(200);
  });

  it("lets requests through when the limiter itself fails (it mustn't take sign-in down)", async () => {
    const broken = { limit: async () => Promise.reject(new Error('limiter down')) } as unknown as RateLimit;
    const req = new Request('https://hub.test/pair/start', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.1' } });
    expect(await limitAnonymous(req, { SIGNIN_LIMIT: broken, ARM_LIMIT: broken })).toBeNull();
    const closed = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await limitAnonymous(req, { SIGNIN_LIMIT: closed, ARM_LIMIT: broken }))?.status).toBe(429);
    expect(await limitAnonymous(new Request('https://hub.test/', { headers: { 'CF-Connecting-IP': '203.0.113.1' } }), { SIGNIN_LIMIT: closed, ARM_LIMIT: closed })).toBeNull();
  });
});

describe('per-account limits', () => {
  async function pairedHub(onCall?: (p: any) => unknown) {
    const user = newUser();
    const { token } = await pairArm(await cookieFor(user), 'fake', 'birch');
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    const arm = await connectArm(token, { name: 'birch', tools: [ECHO], onCall: onCall ?? ((p) => ({ content: [{ type: 'text', text: p.arguments.text }] })) });
    await arm.ready;
    return { stub, arm, token };
  }
  const seed = (stub: DurableObjectStub<UserHub>, count: number, ts: number) =>
    runInDurableObject(stub, (_: UserHub, state) => {
      for (let i = 0; i < count; i++) state.storage.sql.exec("INSERT INTO activity(ts, command, ok, ms) VALUES (?, 'seed', 1, 0)", ts);
    });
  const rows = (stub: DurableObjectStub<UserHub>) => runInDurableObject(stub, (_: UserHub, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM activity').one().n);

  it('words every wait for a model', () => {
    expect([inAbout(400), inAbout(1000), inAbout(59_000), inAbout(120_000), inAbout(5_400_000), inAbout(22 * 3_600_000)]).toEqual(['1 second', '1 second', '59 seconds', '2 minutes', '2 hours', '22 hours']);
    expect(callsPerMinuteText(42_000)).toBe(
      `Cloud Bridge takes up to ${CALLS_PER_MINUTE} tool calls a minute per account, and this account made that many in the last minute, so this call didn't run. Calls work again in 42 seconds; batch tools (like chrome_batch) run several commands as one call.`,
    );
    expect(callsPerDayText(3 * 3_600_000)).toBe(
      "Cloud Bridge takes up to 5,000 tool calls a day per account (it runs on a free plan that all its users share), and this account made that many in the last 24 hours, so this call didn't run. The next call works in about 3 hours. Agents on the user's own computer (chrome-bridge's command line) aren't limited by it.",
    );
  });

  it(`${CALLS_PER_MINUTE} tool calls a minute: the next one is refused with the wait, and the refusal writes nothing`, async () => {
    const { stub, arm } = await pairedHub();
    await seed(stub, CALLS_PER_MINUTE, Date.now() - 1000);
    const before = await rows(stub);
    const res = await stub.callTool('fake_echo', { text: 'x' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/made that many in the last minute, so this call didn't run\. Calls work again in 5\d seconds;/);
    expect(await rows(stub)).toBe(before);
    expect(arm.received.filter((m) => m.method === 'tools/call')).toHaveLength(0);
    arm.ws.close();
  });

  it('calls older than a minute leave room again', async () => {
    const { stub, arm } = await pairedHub();
    await seed(stub, CALLS_PER_MINUTE, Date.now() - 61_000);
    const res = await stub.callTool('fake_echo', { text: 'ok' });
    expect(text(res)).toBe('ok');
    arm.ws.close();
  });

  it(`${CALLS_PER_DAY} a day (the rows activity keeps): refused until the oldest of them is a day old`, async () => {
    const { stub, arm } = await pairedHub();
    await seed(stub, CALLS_PER_DAY, Date.now() - 2 * 3_600_000);
    const res = await stub.callTool('fake_echo', { text: 'x' });
    expect(text(res)).toMatch(/made that many in the last 24 hours, so this call didn't run\. The next call works in about 22 hours\./);
    // One call short of the cap still runs, and activity's pruning keeps the count exact.
    const { stub: other, arm: otherArm } = await pairedHub();
    await seed(other, CALLS_PER_DAY - 1, Date.now() - 2 * 3_600_000);
    expect(text(await other.callTool('fake_echo', { text: 'last' }))).toBe('last');
    expect(text(await other.callTool('fake_echo', { text: 'x' }))).toMatch(/in the last 24 hours/);
    expect(await rows(other)).toBe(CALLS_PER_DAY);
    arm.ws.close();
    otherArm.ws.close();
  });

  it('counts calls still waiting for the arm: a parallel burst cannot slip past the minute limit', async () => {
    const { stub, arm } = await pairedHub(() => undefined); // never answers: every call stays in flight until the 500ms test timeout
    const burst = Array.from({ length: CALLS_PER_MINUTE }, () => stub.callTool('fake_echo', { text: 'x' }));
    await sleep(50);
    const extra = await stub.callTool('fake_echo', { text: 'x' });
    expect(text(extra)).toMatch(/Calls work again in 60 seconds/);
    expect(arm.received.filter((m) => m.method === 'tools/call')).toHaveLength(CALLS_PER_MINUTE);
    await Promise.all(burst);
    expect(await rows(stub)).toBe(CALLS_PER_MINUTE);
    arm.ws.close();
  });
});

describe('arm connections per hour', () => {
  const connects = (stub: DurableObjectStub<UserHub>) =>
    runInDurableObject(stub, (_: UserHub, state) => state.storage.sql.exec<{ connects: number; connects_since: number }>('SELECT connects, connects_since FROM arms').one());
  const setConnects = (stub: DurableObjectStub<UserHub>, n: number, since: number) =>
    runInDurableObject(stub, (_: UserHub, state) => {
      state.storage.sql.exec('UPDATE arms SET connects = ?, connects_since = ?', n, since);
    });

  it(`counts each connection; past ${ARM_CONNECTS_PER_HOUR} in an hour a plain 429 says when, and the live connection stays`, async () => {
    const user = newUser();
    const { token } = await pairArm(await cookieFor(user), 'fake', 'birch');
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    const first = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await first.ready;
    const second = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await second.ready;
    expect((await connects(stub)).connects).toBe(2);
    await setConnects(stub, ARM_CONNECTS_PER_HOUR, Date.now() - 10 * 60_000);
    const res = await hub('/arm', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `cloud-bridge.v1, cbtoken.${token}` } });
    expect(res.status).toBe(429);
    expect(res.webSocket).toBeNull();
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(49 * 60);
    expect(await res.text()).toBe(armConnectsText('fake', 'birch', 50 * 60_000));
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect((await connects(stub)).connects).toBe(ARM_CONNECTS_PER_HOUR);
    // An hour after the first, the count starts again.
    await setConnects(stub, ARM_CONNECTS_PER_HOUR, Date.now() - 61 * 60_000);
    const third = await connectArm(token, { name: 'birch', tools: [ECHO] });
    await third.ready;
    expect((await connects(stub)).connects).toBe(1);
    expect((await second.closed).code).toBe(4000);
    third.ws.close();
  });

  it(`stops at ${FILES_PER_DAY_ALL} a UTC day for all accounts together, and the refused file doesn't count against the account`, async () => {
    const user = newUser();
    const { token } = await pairArm(await cookieFor(user), 'chrome', 'poplar');
    const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: [] });
    await arm.ready;
    let n = 0;
    const keep = async () => {
      const id = `q${++n}`;
      arm.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'arm/file', params: { name: 'a.txt', text: 'x' } }));
      for (let i = 0; i < 100; i++) {
        const got = arm.received.find((m: any) => m.id === id) as any;
        if (got) return got;
        await sleep(10);
      }
      throw new Error(`no answer to ${id}`);
    };
    const day = Math.floor(Date.now() / 86_400_000);
    const quota = env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(QUOTA_OBJECT));
    await quota.put(`quota:files:${day}`, String(FILES_PER_DAY_ALL - 1), null, (day + 1) * 86_400_000);
    expect((await keep()).error).toBeUndefined();
    const refused = await keep();
    expect(refused.error.message).toMatch(/^Cloud Bridge kept as many files today as its free plan allows for all its users \(800\), so nothing was kept; new links work again after 00:00 UTC \(in about .+\)\. The result itself still comes back without --out\/--har$/);
    expect(refused.error.message.replace(/\(in about [^)]+\)/, '')).toBe(filesTodayText(Date.now()).replace(/\(in about [^)]+\)/, ''));
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    const kept = await runInDurableObject(stub, (_: UserHub, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM files').one().n);
    expect(kept).toBe(1);
    // Tomorrow's count is its own.
    await quota.put(`quota:files:${day}`, '0', null, (day + 1) * 86_400_000);
    expect((await keep()).error).toBeUndefined();
    arm.ws.close();
  });

  it('take() counts up to its limit, writes nothing past it, and expires with its day', async () => {
    const quota = env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(`quota-test-${crypto.randomUUID()}`));
    const later = Date.now() + 60_000;
    expect([await quota.take('c', 2, later), await quota.take('c', 2, later), await quota.take('c', 2, later)]).toEqual([true, true, false]);
    expect((await quota.get('c'))?.value).toBe('2');
    expect(await quota.take('old', 1, Date.now() - 1)).toBe(true);
    expect(await quota.take('old', 1, Date.now() - 1)).toBe(true); // an expired count reads as zero
  });
});
