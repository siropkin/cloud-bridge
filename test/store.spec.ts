import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { oauthKv, shardOf, SHARDS, type OAuthStore } from '../src/store';
import { accessToken, cookieFor, hub, newUser } from './helpers';

const kvNames = async () => (await env.OAUTH_KV.list()).keys.map((k) => k.name);
const storeOf = (name: string) => env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(shardOf(name)));
const tables = (stub: DurableObjectStub<OAuthStore>) =>
  runInDurableObject(stub, (_: OAuthStore, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));

describe('OAuth and sign-in state live in Durable Objects, not KV (S1: free KV takes 1,000 writes a day for everyone)', () => {
  it('anonymous requests write nothing to KV', async () => {
    const before = new Set(await kvNames());
    const redirect = 'https://app.example/cb';
    const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Flood', token_endpoint_auth_method: 'none' }) })).json()) as any;
    expect(reg.client_id).toBeTruthy();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
    expect((await hub(`/authorize?${q}`)).status).toBe(200);
    expect((await hub('/login?next=/', { redirect: 'manual' })).status).toBe(302);
    expect((await hub('/pair/start', { method: 'POST', body: JSON.stringify({ kind: 'chrome', name: 'oak' }) })).status).toBe(200);
    const added = (await kvNames()).filter((n) => !before.has(n));
    expect(added).toEqual([]);
  });

  it('a whole connection (consent, code, token) keeps its grant and tokens in the user\'s own object', async () => {
    const user = newUser();
    const token = await accessToken(await cookieFor(user));
    expect(token.startsWith(`${user.uid}:`)).toBe(true);
    const rows = await runInDurableObject(env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(`user:${user.uid}`)), (_: OAuthStore, state) =>
      state.storage.sql.exec('SELECT name FROM kv ORDER BY name').toArray().map((r) => String(r.name).split(':')[0]),
    );
    expect(rows).toEqual(['grant', 'token']);
    expect((await kvNames()).some((n) => n.includes(user.uid))).toBe(false);
  });

  it('a forged access token creates no storage for the user it names', async () => {
    const uid = `gh-forged-${crypto.randomUUID()}`;
    const res = await hub('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${uid}:g1:${'x'.repeat(32)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await tables(storeOf(`token:${uid}:g1:x`))).toEqual([]);
  });

  it('never reads OAuth state from KV: a grant, token or client there is not served, listed or touched (decision no-legacy)', async () => {
    const store = oauthKv(env);
    const uid = `gh-kv-${crypto.randomUUID()}`;
    const names = [`grant:${uid}:g1`, `token:${uid}:g1:t`, `client:${crypto.randomUUID()}`];
    for (const name of names) await env.OAUTH_KV.put(name, '{"id":"x"}', { metadata: { clientId: 'c1' } });
    for (const name of names) expect(await store.get(name)).toBeNull();
    expect((await store.list({ prefix: `grant:${uid}:` })).keys).toEqual([]);
    await store.delete(names[0]);
    for (const name of names) expect(await env.OAUTH_KV.get(name)).toBe('{"id":"x"}');
  });

  it('expired entries read as gone at once and are swept by the alarm', async () => {
    const store = oauthKv(env);
    const name = `pair:EXPR-${crypto.randomUUID().slice(0, 4)}`;
    await store.put(name, '{"x":1}', { expirationTtl: 60 });
    const stub = storeOf(name);
    expect((await stub.get(name))?.value).toBe('{"x":1}');
    expect(await stub.get(name, Date.now() + 61_000)).toBeNull();
    const left = await runInDurableObject(stub, async (instance: OAuthStore, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec('UPDATE kv SET expires = 1 WHERE name = ?', name);
      await instance.alarm();
      return state.storage.sql.exec('SELECT COUNT(*) AS n FROM kv WHERE name = ?', name).one().n;
    });
    expect(left).toBe(0);
  });

  it('a short-lived key moves a far-off sweep earlier (review of S2c: a moved client record\'s alarm months out kept every later pairing — place and token — on disk that long)', async () => {
    const store = oauthKv(env);
    const short = `pair:SOON-${crypto.randomUUID().slice(0, 4)}`;
    const stub = storeOf(short);
    const far = Date.now() + 90 * 86_400_000;
    await runInDurableObject(stub, (_: OAuthStore, state) => state.storage.setAlarm(far));
    await store.put(short, '{"x":1}', { expirationTtl: 300 });
    const alarm = await runInDurableObject(stub, (_: OAuthStore, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 300_000 + 15 * 60_000);
    // A longer-lived key in the same object never pushes the sweep later.
    let long = '';
    for (let i = 0; shardOf(long) !== shardOf(short); i++) long = `pair:LONG-${i}`;
    await store.put(long, '{}', { expirationTtl: 86_400 });
    expect(await runInDurableObject(stub, (_: OAuthStore, state) => state.storage.getAlarm())).toBe(alarm);
  });

  it('lists across shards in order, page by page, with metadata', async () => {
    const store = oauthKv(env);
    const prefix = `client:list-${crypto.randomUUID().slice(0, 8)}-`;
    const names = Array.from({ length: 7 }, (_, i) => `${prefix}${i}`);
    expect(new Set(names.map(shardOf)).size).toBeGreaterThan(1);
    expect(names.every((n) => /^shard:\d+$/.test(shardOf(n)) && Number(shardOf(n).split(':')[1]) < SHARDS)).toBe(true);
    for (const n of names) await store.put(n, 'v', { metadata: { n } });
    const seen: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ prefix, limit: 3, cursor });
      seen.push(...page.keys);
      cursor = page.list_complete ? undefined : (page as { cursor: string }).cursor;
    } while (cursor);
    expect(seen).toEqual(names.map((n) => ({ name: n, metadata: { n } })));
    await expect(store.list({ prefix: 'grant:' })).rejects.toThrow(/one user's grants or tokens at a time/);
  });
});
