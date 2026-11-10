import { DurableObject } from 'cloudflare:workers';

// Where the hub keeps OAuth state (the OAuth library's clients, consent and
// sign-in transactions, grants, tokens) and its own short-lived state (pairing
// codes, web sign-ins), behind the KV interface the library expects.
//
// Workers KV on the free plan takes 1,000 writes a day for the whole account,
// and anonymous requests wrote to it: about 1,000 of them (/register, GET
// /authorize, /login, /pair/start; an <img> on a busy page would do) stopped
// sign-in and token refresh for every user until midnight UTC, and each
// connected AI app used ~48 a day just refreshing (S1). SQLite-backed Durable
// Objects take 100,000 row writes a day, the same order as the Worker's own
// 100,000 requests. KV keeps only file blobs (files.ts: too big for a row).
//
// Keys that carry a user id (grant:<user>:…, token:<user>:…) live in that
// user's object, so signed-in apps never queue behind an anonymous flood; the
// rest spread over SHARDS objects by a hash of the key.
export const SHARDS = 8;
const USER_KEY = /^(?:grant|token):([^:]+):/;
// Keys written to KV before the move. Read once from there, then moved here;
// the newest expires within 90 days of the move (2026-11-09). Drop in E1.
const LEGACY = /^(?:client|grant|token):/;
// Expired rows are invisible at once and deleted in batches this far apart.
const SWEEP_MS = 15 * 60_000;

// Across RPC metadata travels as its JSON text (unknown isn't serializable); the adapter parses it.
export interface Entry {
  value: string;
  metadata?: string;
  expiration?: number; // seconds, as KV reports it
}

export interface Listed {
  name: string;
  metadata?: string;
  expiration?: number;
}

type Row = { name: string; value: string; metadata: string | null; expires: number | null };

export class OAuthStore extends DurableObject<Env> {
  private sql: SqlStorage;
  private table = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // No table until the first write: an access token is "<user>:<grant>:<secret>",
  // so a forged one names any user's object, and a read must not create storage.
  private has(create = false): boolean {
    if (!this.table) this.table = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").toArray().length > 0;
    if (!this.table && create) {
      this.sql.exec('CREATE TABLE kv(name TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expires INTEGER)');
      this.table = true;
    }
    return this.table;
  }

  private entry(row: Pick<Row, 'metadata' | 'expires'>): { metadata?: string; expiration?: number } {
    return {
      ...(row.metadata === null ? {} : { metadata: row.metadata }),
      ...(row.expires === null ? {} : { expiration: Math.floor(row.expires / 1000) }),
    };
  }

  async get(name: string, now = Date.now()): Promise<Entry | null> {
    if (!this.has()) return null;
    const row = this.sql.exec<Row>('SELECT value, metadata, expires FROM kv WHERE name = ?', name).toArray()[0];
    if (!row || (row.expires !== null && row.expires <= now)) return null;
    return { value: row.value, ...this.entry(row) };
  }

  async put(name: string, value: string, metadata: string | null, expires: number | null): Promise<void> {
    this.has(true);
    this.sql.exec('INSERT OR REPLACE INTO kv(name, value, metadata, expires) VALUES (?, ?, ?, ?)', name, value, metadata, expires);
    if (expires !== null && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Math.max(expires, Date.now()) + SWEEP_MS);
  }

  async delete(name: string): Promise<boolean> {
    if (!this.has()) return false;
    return this.sql.exec('DELETE FROM kv WHERE name = ?', name).rowsWritten > 0;
  }

  // Compare-and-set for the hub's own records: an object runs one call at a time
  // (storage awaits hold its input gate), so no other request lands in between,
  // where KV's get-then-put let two approvals of one pairing both see "pending".
  async swap(name: string, expected: string, value: string, expires: number | null): Promise<boolean> {
    if ((await this.get(name))?.value !== expected) return false;
    await this.put(name, value, null, expires);
    return true;
  }

  // Names after `after`, in order, up to `limit`.
  async list(prefix: string, limit: number, after: string, now = Date.now()): Promise<Listed[]> {
    if (!this.has()) return [];
    return this.sql
      .exec<Row>('SELECT name, metadata, expires FROM kv WHERE substr(name, 1, ?) = ? AND name > ? AND (expires IS NULL OR expires > ?) ORDER BY name LIMIT ?', prefix.length, prefix, after, now, limit)
      .toArray()
      .map((row) => ({ name: row.name, ...this.entry(row) }));
  }

  async alarm(): Promise<void> {
    if (!this.has()) return;
    const now = Date.now();
    this.sql.exec('DELETE FROM kv WHERE expires IS NOT NULL AND expires <= ?', now);
    const next = this.sql.exec<{ t: number | null }>('SELECT MIN(expires) AS t FROM kv').one().t;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now) + SWEEP_MS);
  }
}

function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h;
}

export function shardOf(name: string): string {
  const user = USER_KEY.exec(name)?.[1];
  return user ? `user:${user}` : `shard:${hash(name) % SHARDS}`;
}

function shardsFor(prefix: string): string[] {
  const user = USER_KEY.exec(prefix)?.[1];
  if (user) return [`user:${user}`];
  // Every user's grants or tokens at once: only the library's admin helpers ask, and the hub never calls them.
  if (/^(?:grant|token):/.test(prefix) || !prefix) throw new Error(`the hub's store lists one user's grants or tokens at a time, not "${prefix}*"`);
  return Array.from({ length: SHARDS }, (_, i) => `shard:${i}`);
}

type GetOptions = 'text' | 'json' | { type?: 'text' | 'json'; cacheTtl?: number };
type PutOptions = { expiration?: number; expirationTtl?: number; metadata?: unknown };
type ListOptions = { prefix?: string; limit?: number; cursor?: string | null };

// The KV namespace the OAuth library and the hub's pages see (env.OAUTH_KV in
// the Worker). Text values only: the library stores JSON strings, files stay in KV.
export function oauthKv(env: Env): KVNamespace {
  const stub = (shard: string) => env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(shard));
  const legacy = env.OAUTH_KV;

  // A key written before the move: serve it and move it here with its expiry and
  // metadata (grants carry metadata the library lists by), so KV never answers twice.
  async function fromLegacy(name: string): Promise<string | null> {
    if (!LEGACY.test(name)) return null;
    const value = await legacy.get(name, 'text');
    if (value === null) return null;
    const listed = (await legacy.list({ prefix: name, limit: 10 })).keys.find((k) => k.name === name);
    await stub(shardOf(name)).put(name, value, listed?.metadata == null ? null : JSON.stringify(listed.metadata), listed?.expiration ? listed.expiration * 1000 : null);
    try {
      await legacy.delete(name);
    } catch {
      // Still in KV: don't keep a second copy that could outlive a later delete here.
      await stub(shardOf(name)).delete(name);
    }
    return value;
  }

  const store = {
    async get(name: string, options?: GetOptions): Promise<unknown> {
      const type = (typeof options === 'string' ? options : options?.type) ?? 'text';
      if (type !== 'text' && type !== 'json') throw new Error(`the hub's OAuth store keeps text; get(${type}) isn't supported`);
      const value = (await stub(shardOf(name)).get(name))?.value ?? (await fromLegacy(name));
      return value === null ? null : type === 'json' ? JSON.parse(value) : value;
    },
    async put(name: string, value: unknown, options: PutOptions = {}): Promise<void> {
      if (typeof value !== 'string') throw new Error(`the hub's OAuth store keeps text; ${name} got ${typeof value}`);
      const expires = options.expiration ? options.expiration * 1000 : options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      await stub(shardOf(name)).put(name, value, options.metadata == null ? null : JSON.stringify(options.metadata), expires);
    },
    async delete(name: string): Promise<void> {
      if (await stub(shardOf(name)).delete(name)) return;
      // Only a key KV really holds: a delete there is one of its scarce writes.
      if (LEGACY.test(name) && (await legacy.get(name, 'text')) !== null) await legacy.delete(name);
    },
    // Not merged with KV: an unmoved legacy grant's tokens (1 h) don't list until it's read once.
    async list(options: ListOptions = {}): Promise<{ keys: { name: string; metadata?: unknown; expiration?: number }[]; list_complete: boolean; cursor?: string; cacheStatus: null }> {
      const prefix = options.prefix ?? '';
      const limit = Math.min(Math.max(1, options.limit ?? 1000), 1000);
      const pages = await Promise.all(shardsFor(prefix).map((s) => stub(s).list(prefix, limit + 1, options.cursor ?? '')));
      const keys = pages.flat().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const page = keys.slice(0, limit).map(({ metadata, ...k }) => (metadata === undefined ? k : { ...k, metadata: JSON.parse(metadata) as unknown }));
      return keys.length > limit ? { keys: page, list_complete: false, cursor: page[page.length - 1].name, cacheStatus: null } : { keys: page, list_complete: true, cacheStatus: null };
    },
    async getWithMetadata(): Promise<never> {
      throw new Error("the hub's OAuth store doesn't serve getWithMetadata; files use KV directly");
    },
  };
  return store as unknown as KVNamespace;
}

// The hub's own compare-and-set (pairing approval): true when `name` held exactly
// `expected` and now holds `value`.
export function swapText(env: Env, name: string, expected: string, value: string, expirationTtl: number): Promise<boolean> {
  return env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName(shardOf(name))).swap(name, expected, value, Date.now() + expirationTtl * 1000);
}
