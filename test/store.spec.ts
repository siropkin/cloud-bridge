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

  it('a key from before the move is served once from KV, then moved with its expiry and metadata', async () => {
    const store = oauthKv(env);
    const name = `grant:gh-legacy-${crypto.randomUUID()}:g1`;
    const expiration = Math.floor(Date.now() / 1000) + 7200;
    await env.OAUTH_KV.put(name, JSON.stringify({ id: 'g1' }), { expiration, metadata: { clientId: 'c1' } });
    expect(await store.get(name, { type: 'json' })).toEqual({ id: 'g1' });
    expect(await env.OAUTH_KV.get(name)).toBeNull();
    const listed = await store.list({ prefix: name.slice(0, name.lastIndexOf(':') + 1) });
    expect(listed.keys).toEqual([{ name, expiration, metadata: { clientId: 'c1' } }]);
    // Deleting it here is final: KV no longer answers for it.
    await store.delete(name);
    expect(await store.get(name)).toBeNull();
  });

  it('a client registered before the move still connects (Claude\'s and ChatGPT\'s records were in KV)', async () => {
    const redirect = 'https://legacy.example/cb';
    const reg = (await (await hub('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Legacy app', token_endpoint_auth_method: 'none' }) })).json()) as any;
    const name = `client:${reg.client_id}`;
    // Put it back where the old hub kept it: in KV only.
    await env.OAUTH_KV.put(name, (await oauthKv(env).get(name)) as string);
    expect(await storeOf(name).delete(name)).toBe(true);
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: env.MCP_RESOURCE });
    const consent = await hub(`/authorize?${q}`, { headers: { Cookie: await cookieFor(newUser()) } });
    expect(await consent.text()).toContain('Allow Legacy app to use your Chrome?');
    expect(await env.OAUTH_KV.get(name)).toBeNull();
    expect((await storeOf(name).get(name))?.value).toContain(reg.client_id);
  });

  it('a user\'s grants from before the move are listed (re-authorizing revokes them by listing), then live here only (review)', async () => {
    const store = oauthKv(env);
    const uid = `gh-legacy-${crypto.randomUUID()}`;
    const expiration = Math.floor(Date.now() / 1000) + 7200;
    for (const g of ['g1', 'g2']) await env.OAUTH_KV.put(`grant:${uid}:${g}`, JSON.stringify({ id: g }), { expiration, metadata: { clientId: 'c1' } });
    await store.put(`grant:${uid}:g3`, '{"id":"g3"}');
    const listed = await store.list({ prefix: `grant:${uid}:` });
    expect(listed.keys.map((k) => k.name)).toEqual([`grant:${uid}:g1`, `grant:${uid}:g2`, `grant:${uid}:g3`]);
    expect(listed.keys[0]).toEqual({ name: `grant:${uid}:g1`, expiration, metadata: { clientId: 'c1' } });
    expect((await env.OAUTH_KV.list({ prefix: `grant:${uid}:` })).keys).toEqual([]);
  });

  it('a deleted key never comes back from KV, and a move whose KV delete fails fails the read (review)', async () => {
    const uid = `gh-legacy-${crypto.randomUUID()}`;
    const name = `grant:${uid}:g1`;
    // A copy in KV beside a newer one here (a move whose KV delete was lost): delete removes both.
    await env.OAUTH_KV.put(name, '{"v":0}');
    await storeOf(name).put(name, '{"v":1}', null, null);
    const store = oauthKv(env);
    await store.delete(name);
    expect(await store.get(name)).toBeNull();
    expect(await env.OAUTH_KV.get(name)).toBeNull();
    // KV refuses the delete during a move: the read fails, nothing is kept here, KV still answers next time.
    await env.OAUTH_KV.put(name, '{"v":0}');
    const failing = oauthKv({ ...env, OAUTH_KV: { get: (n: string, t: any) => env.OAUTH_KV.get(n, t), list: (o: any) => env.OAUTH_KV.list(o), delete: async () => { throw new Error('KV delete limit exceeded'); } } as unknown as KVNamespace });
    await expect(failing.get(name)).rejects.toThrow('KV delete limit exceeded');
    expect(await storeOf(name).get(name)).toBeNull();
    expect(await store.get(name)).toBe('{"v":0}');
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
