import { DurableObject } from 'cloudflare:workers';
import { buildToolList, resolveCall, type ArmInfo, type ArmTool, type HubTool } from './tools';
import { randomToken, sha256, b64url } from './util';
import { downloadPublic } from './download';
import { deleteFiles, FILE_MAX, FILES_PER_DAY, getFile, putFile, safeName, type FileMeta } from './files';
import { ARM_CONNECTS_PER_HOUR, CALLS_PER_DAY, CALLS_PER_MINUTE, DAY_MS, FILES_PER_DAY_ALL, HOUR_MS, MINUTE_MS, armConnectsText, callsPerDayText, callsPerMinuteText, filesTodayText } from './limits';
import { takeQuota } from './store';
import { armLabel } from './kinds';

export const ARM_PROTOCOL = 'cloud-bridge.v1';
const ARM_KINDS = /^[a-z][a-z0-9-]{0,23}$/;

// The Activity page's live feed (/app/activity/live): a hibernatable socket of
// its own kind, which never counts as an arm and whose messages are ignored.
export const VIEWER = 'viewer';
export const LIVE_PATH = '/app/activity/live';
export const VIEWERS_MAX = 10;
export const CATCH_UP_MAX = 200;
interface ViewerAttachment {
  viewer: true;
  since: number;
}

interface Attachment {
  viewer?: undefined;
  armId: string;
  userId?: string; // whose hub this is (absent on sockets from before it existed)
  // One per socket: a replaced connection's late close must not fail calls on its successor.
  connId: string;
  ready: boolean; // hello received and tools listed
  hello?: boolean; // hello received (absent on sockets from before it existed)
  since?: number; // when the socket opened (absent on sockets from before it existed)
}

// Arms send "ping" every 20s (answered by the runtime, never waking the object).
// A socket with no ping for this long is dead without having closed: calls on it
// waited the full 120s timeout (found live with ChatGPT, 2026-11-09).
export const HEARTBEAT_STALE_MS = 75_000;

interface Pending {
  connId: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CallMeta {
  client?: string; // the OAuth client id
  clientName?: string; // its name when the user allowed it (absent on tokens from before D2)
  session?: string;
}

// What an arm may say about a call in its result's _meta, for the Activity page:
// the command word, the site it acted on, and — kept only while the person
// opted in to details — its replay line (secrets already "***") and a preview
// of its answer, both the arm's own people-safe forms. The hub never parses
// arguments or results for these (arm-agnostic) and never forwards _meta.
export const ACTIVITY_META = 'cloud-bridge/activity';
export const LINE_MAX = 8_200;
export const PREVIEW_MAX = 2_000;
export interface Report {
  command: string | null;
  site: string | null;
  line: string | null;
  preview: string | null;
}
const NO_REPORT: Report = { command: null, site: null, line: null, preview: null };
export function reportedActivity(meta: unknown): Report {
  const a = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[ACTIVITY_META] : null;
  const r = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
  const command = typeof r.command === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(r.command) ? r.command : null;
  const site = typeof r.site === 'string' && r.site.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i.test(r.site) ? r.site.toLowerCase() : null;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return { command, site, line: text(r.line, LINE_MAX), preview: text(r.preview, PREVIEW_MAX) };
}

// "Keep details for 24 hours" (off by default): per step, the arm's line and
// preview plus the result's first image, for a day, within a per-account cap
// (every account shares the Free plan's Durable Object storage). Past the cap
// the oldest details go first; their steps stay listed and say so.
export const DETAILS_MS = 24 * 3600_000;
export const DETAILS_CAP = 10 * 1048576;
export const IMAGE_MAX = 300 * 1024;
// The sweep after a detail kept at `ts` expires, on the hour (see UserHub.sweepLater).
export const sweepAt = (ts: number) => Math.ceil((ts + DETAILS_MS) / 3600_000) * 3600_000;
const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/;
export interface StepDetails {
  line: string | null;
  preview: string | null;
  image: boolean;
  imageTooBig: boolean;
}

// One activity row as the Activity page shows it.
export type ActivityView = {
  id: number;
  ts: number;
  client: string | null;
  clientName: string | null;
  profile: string | null; // the arm's current name; null when none was reached or it was removed
  profileGone: number; // 1: it reached an arm that's since been removed
  tool: string;
  command: string | null; // the arm's word for it (e.g. "snap"), when it said
  site: string | null;
  ok: number;
  ms: number;
  error: string | null; // a plain-words note for the person (the hub's, never an arm's text)
  details: number; // 0: none kept, 1: kept (open them), 2: removed to make room
};

// MCP content blocks as arms send them (text, image, resource…), passed through untouched.
export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export type ActivityRow = {
  ts: number;
  client: string | null;
  arm_id: string | null;
  command: string;
  ok: number;
  ms: number;
  error: string | null;
};

// One connected arm as the account page shows it (no token, no tools).
export interface ArmDetails {
  id: string;
  kind: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  version: string | null;
  createdAt: number;
}

type ArmRow = {
  id: string;
  kind: string;
  name: string;
  version: string | null;
  token_hash: string;
  created_at: number;
  last_seen: number | null;
  tools: string | null;
  selector: string | null;
  offline_hint: string | null;
  connects: number | null; // connections in the hour since connects_since
  connects_since: number | null;
};

// "cba_<base64url(userId)>.<secret>": the worker routes on the user part, the hub checks the hash.
export function armTokenUser(token: string): string | null {
  const m = /^cba_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{32,}$/.exec(token);
  if (!m) return null;
  try {
    return atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
}

// Arms can't read a refused handshake's HTTP status (browser WebSockets only see 1006),
// so a bad token gets an accepted socket closed at once with 4401 and the next step.
export const UNPAIRED = 4401;
export function refuse(request: Request, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(UNPAIRED, reason);
  const headers = new Headers();
  if (request.headers.get('Sec-WebSocket-Protocol')) headers.set('Sec-WebSocket-Protocol', ARM_PROTOCOL);
  return new Response(null, { status: 101, webSocket: client, headers });
}

export function validArm(kind: unknown, name: unknown): string | null {
  if (typeof kind !== 'string' || !ARM_KINDS.test(kind)) return 'kind must be lowercase letters, digits or "-" (e.g. "chrome"), at most 24 characters';
  if (typeof name !== 'string' || !name.trim() || name.length > 64) return 'name must be 1-64 characters (e.g. the Chrome profile name)';
  return null;
}

export class UserHub extends DurableObject<Env> {
  private sql: SqlStorage;
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Heartbeats are answered without waking the object (no free-tier request spent).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Tables appear with this user's first real write (a pairing, a call), never on
  // a bare wake: the worker picks the object by a user id anyone can put in a
  // token, and a schema per forged request wrote rows and kept storage forever (S1).
  private schema = false;
  private has(): boolean {
    if (!this.schema && this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arms'").toArray().length) this.ensure();
    return this.schema;
  }

  private ensure(): void {
    if (this.schema) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS arms(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version TEXT, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen INTEGER, tools TEXT, selector TEXT, offline_hint TEXT,
      connects INTEGER, connects_since INTEGER)`);
    // Hubs made before the connection count (S2a) get its columns on their next wake.
    const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(arms)').toArray().map((c) => c.name));
    if (!columns.has('connects')) this.sql.exec('ALTER TABLE arms ADD COLUMN connects INTEGER');
    if (!columns.has('connects_since')) this.sql.exec('ALTER TABLE arms ADD COLUMN connects_since INTEGER');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS activity(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, client TEXT, arm_id TEXT, command TEXT NOT NULL,
      target_host TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, result_ref TEXT, verb TEXT, client_name TEXT)`);
    // Hubs made before the Activity page (D2): the arm's command word and the AI app's name.
    const logged = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(activity)').toArray().map((c) => c.name));
    if (!logged.has('verb')) this.sql.exec('ALTER TABLE activity ADD COLUMN verb TEXT');
    if (!logged.has('client_name')) this.sql.exec('ALTER TABLE activity ADD COLUMN client_name TEXT');
    this.sql.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, json TEXT NOT NULL)');
    // One row per step whose details were kept; dropped = removed to make room
    // (its content is gone, the row says so until the day is over).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS details(
      activity_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, line TEXT, preview TEXT, image BLOB, image_type TEXT,
      image_too_big INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, dropped INTEGER NOT NULL DEFAULT 0)`);
    // When files were kept (the bytes live in KV): the daily cap counts these.
    this.sql.exec('CREATE TABLE IF NOT EXISTS files(ts INTEGER NOT NULL, size INTEGER NOT NULL)');
    // Whose hub this is: ctx.id.name when the caller used idFromName (every caller
    // here does), kept for wakes that may lack it (a hibernated socket's message).
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (this.ctx.id.name) this.sql.exec("INSERT OR IGNORE INTO meta(key, value) VALUES ('user', ?)", this.ctx.id.name);
    // Rows from before plain notes (D2a) hold the AI app's text, which the
    // Activity page would show people: clear it once (the page then says only
    // that it didn't work).
    if (!this.sql.exec("SELECT 1 FROM meta WHERE key = 'notes'").toArray().length) {
      this.sql.exec('UPDATE activity SET error = NULL WHERE error IS NOT NULL AND error != ?', ARM_ERROR);
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('notes', '1')");
    }
    this.schema = true;
  }

  // No replacing by name: chrome-bridge profile names come from 20 words, so two
  // profiles can share one (review). An arm that re-pairs revokes its old token
  // itself (POST /arm/revoke), retrying until the hub answers.
  async createArm(userId: string, kind: string, name: string): Promise<{ armId: string; token: string }> {
    this.ensure();
    const armId = crypto.randomUUID();
    const token = `cba_${b64url(new TextEncoder().encode(userId))}.${randomToken(32)}`;
    this.sql.exec('INSERT INTO arms(id, kind, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', armId, kind, name.trim(), await sha256(token), Date.now());
    return { armId, token };
  }

  // The arm signs itself out (Cloud AI apps switched off, extension removed):
  // its record goes, so AI apps stop seeing it. Idempotent.
  async revokeArm(token: string): Promise<boolean> {
    if (!this.has()) return false;
    const row = this.sql.exec<{ id: string }>('SELECT id FROM arms WHERE token_hash = ?', await sha256(token)).toArray()[0];
    if (!row) return false;
    this.dropArm(row.id, 'signed out of Cloud Bridge');
    return true;
  }

  private dropArm(id: string, why: string): void {
    this.sql.exec('DELETE FROM arms WHERE id = ?', id);
    for (const ws of this.ctx.getWebSockets(id)) {
      // A server-side close fires no webSocketClose here: fail its calls now.
      this.gone(ws, why);
      try {
        ws.close(UNPAIRED, why);
      } catch {
        // already closed
      }
    }
  }

  // For people's pages (the consent page names what an app gets): no tokens, no tools.
  async armSummary(): Promise<{ kind: string; name: string; online: boolean }[]> {
    return this.arms().map(({ kind, name, online }) => ({ kind, name, online }));
  }

  // The account page's list: what each connected arm is and whether it's there now.
  async armDetails(): Promise<ArmDetails[]> {
    if (!this.has()) return [];
    const extra = new Map(this.sql.exec<{ id: string; version: string | null; created_at: number }>('SELECT id, version, created_at FROM arms').toArray().map((r) => [r.id, r]));
    return this.arms().map(({ id, kind, name, online, lastSeen }) => ({ id, kind, name, online, lastSeen, version: extra.get(id)?.version ?? null, createdAt: extra.get(id)?.created_at ?? 0 }));
  }

  // The name AI apps pick it by (the tools' selector), so two of a kind can't share one
  // after a rename: calls go to the first name that matches.
  async renameArm(id: string, name: string): Promise<'ok' | 'gone' | 'taken'> {
    if (!this.has()) return 'gone';
    const row = this.sql.exec<{ kind: string }>('SELECT kind FROM arms WHERE id = ?', id).toArray()[0];
    if (!row) return 'gone';
    // In JS, as resolveCall compares: SQLite's lower() folds only A-Z ("Работа" vs "РАБОТА" passed).
    const wanted = name.toLowerCase();
    const clash = this.sql.exec<{ name: string }>('SELECT name FROM arms WHERE kind = ? AND id != ?', row.kind, id).toArray().some((r) => r.name.toLowerCase() === wanted);
    if (clash) return 'taken';
    this.sql.exec('UPDATE arms SET name = ? WHERE id = ?', name, id);
    for (const ws of this.ctx.getWebSockets(id)) this.sendName(ws, name);
    return 'ok';
  }

  // Disconnect from the account page: the record and its token go, the socket
  // closes with 4401 so the arm stops redialing and tells its person.
  async disconnectArm(id: string): Promise<boolean> {
    if (!this.has() || !this.sql.exec('SELECT 1 FROM arms WHERE id = ?', id).toArray().length) return false;
    this.dropArm(id, 'disconnected on the Cloud Bridge page');
    return true;
  }

  // "Delete my data": every arm signed out (4401) and its calls failed, then all
  // of this object's storage, then the files it kept in KV. The OAuth grants
  // live in the store; the page revokes those first (src/app.ts).
  async deleteEverything(userId: string): Promise<{ arms: number; files: number | null }> {
    const arms = this.has() ? this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM arms').one().n : 0;
    for (const ws of this.ctx.getWebSockets()) {
      this.gone(ws, 'signed out of Cloud Bridge: the account was deleted');
      try {
        ws.close(UNPAIRED, 'signed out of Cloud Bridge: the account was deleted');
      } catch {
        // already closed
      }
    }
    // Before and after: the failed calls' rows are recorded around this await, and
    // a cached "tables exist" would send them into tables that are gone.
    this.schema = false;
    await this.ctx.storage.deleteAll();
    this.schema = false;
    return { arms, files: await deleteFiles(this.env.OAUTH_KV, userId) };
  }

  // The /arm WebSocket upgrade, forwarded by the worker with the token in x-arm-token;
  // or the Activity page's live feed, forwarded only after its sign-in check (index.ts
  // routes that path nowhere else, and /arm keeps its own path).
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === LIVE_PATH) return this.watch(Number(url.searchParams.get('after')) || 0);
    const token = request.headers.get('x-arm-token') ?? '';
    if (!this.has()) return refuse(request, 'unknown or revoked arm token: pair this arm again');
    const row = this.sql.exec<ArmRow>('SELECT * FROM arms WHERE token_hash = ?', await sha256(token)).toArray()[0];
    if (!row) return refuse(request, 'unknown or revoked arm token: pair this arm again');
    // A plain 429 (no socket): browsers grow their reconnect backoff on a failed
    // handshake, where an accepted-then-closed socket resets it. Checked before
    // the live connection is replaced, and nothing is written.
    const now = Date.now();
    const fresh = !row.connects_since || now - row.connects_since >= HOUR_MS;
    if (!fresh && (row.connects ?? 0) >= ARM_CONNECTS_PER_HOUR) {
      const wait = row.connects_since! + HOUR_MS - now;
      return new Response(armConnectsText(row.kind, row.name, wait), { status: 429, headers: { 'Retry-After': String(Math.ceil(wait / 1000)), 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    for (const old of this.ctx.getWebSockets(row.id)) old.close(4000, 'replaced by a newer connection of the same arm');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [row.id]);
    server.serializeAttachment({ armId: row.id, userId: armTokenUser(token) ?? undefined, connId: crypto.randomUUID(), ready: false, since: now } satisfies Attachment);
    this.sql.exec('UPDATE arms SET last_seen = ?, connects = ?, connects_since = ? WHERE id = ?', now, fresh ? 1 : (row.connects ?? 0) + 1, fresh ? now : row.connects_since, row.id);
    const headers = new Headers();
    if (request.headers.get('Sec-WebSocket-Protocol')) headers.set('Sec-WebSocket-Protocol', ARM_PROTOCOL);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    // The Activity page only listens ("ping" is answered by the runtime).
    if ((ws.deserializeAttachment() as ViewerAttachment | null)?.viewer) return;
    if (!this.has()) return ws.close(UNPAIRED, 'unknown or revoked arm token: pair this arm again');
    const att = ws.deserializeAttachment() as Attachment;
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: send JSON-RPC 2.0 text frames' } }));
      return;
    }
    if (msg.method === 'arm/hello') return this.hello(ws, att, msg.params ?? {});
    if (msg.method === 'arm/download' && msg.id !== undefined) return this.download(ws, msg.id, msg.params ?? {});
    if (msg.method === 'arm/file' && msg.id !== undefined) return this.keepFile(ws, att, msg.id, msg.params ?? {});
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ArmAnswer(msg.error.message ?? 'the arm returned an error'));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.gone(ws, `disconnected (${code}${reason ? ` ${reason}` : ''})`);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws, 'connection error');
  }

  // seen: when the arm was last heard from. A socket closed for its silence was
  // last heard at its last ping, not now: stamping now made a Chrome asleep all
  // night read "last seen 7s ago" to an AI app (found live, 2026-11-10).
  private gone(ws: WebSocket, why: string, seen = Date.now()): void {
    const att = ws.deserializeAttachment() as Attachment | ViewerAttachment | null;
    if (!att || att.viewer) return;
    if (this.has()) this.sql.exec('UPDATE arms SET last_seen = MAX(COALESCE(last_seen, 0), ?) WHERE id = ?', seen, att.armId);
    for (const [id, p] of this.pending) {
      if (p.connId !== att.connId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`the arm ${why} before answering`));
    }
  }

  // Once per connection (arms send it on open). Each hello writes the arm's row
  // twice and asks for its tools: repeated on one socket it spent the account's
  // shared Durable Object write budget (100k rows/day) with no request cost (S1).
  private async hello(ws: WebSocket, att: Attachment, params: Record<string, unknown>): Promise<void> {
    if (att.hello || att.ready) {
      try {
        ws.close(4400, 'arm/hello is sent once per connection: reconnect to announce again');
      } catch {
        // already closed
      }
      return;
    }
    const greeted: Attachment = { ...att, hello: true };
    ws.serializeAttachment(greeted);
    const str = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    this.sql.exec(
      'UPDATE arms SET version = ?, selector = ?, offline_hint = ?, last_seen = ? WHERE id = ?',
      str(params.version, 32),
      str(params.selector, 32),
      str(params.offlineHint, 300),
      Date.now(),
      att.armId,
    );
    const policy = { commands: {}, blockedDomains: [] }; // D3 fills these from settings
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/policy', params: policy }));
    const named = this.sql.exec<{ name: string }>('SELECT name FROM arms WHERE id = ?', att.armId).toArray()[0];
    if (named) this.sendName(ws, named.name);
    try {
      const listed = await this.request(ws, att.connId, 'tools/list', {});
      const tools = Array.isArray(listed.tools) ? (listed.tools as ArmTool[]).filter((t) => typeof t?.name === 'string') : [];
      this.sql.exec('UPDATE arms SET tools = ? WHERE id = ?', JSON.stringify(tools), att.armId);
      ws.serializeAttachment({ ...greeted, ready: true } satisfies Attachment);
    } catch (error) {
      try {
        ws.close(4002, `tools/list failed: ${(error as Error).message}`.slice(0, 120));
      } catch {
        // the socket itself is what failed
      }
    }
  }

  // arm/name: the name AI apps pick this arm by (renamed on /app). Arms keep
  // their own name; chrome-bridge accepts this one too where a command line
  // names its profile ("--profile Work"), which the hub never parses.
  private sendName(ws: WebSocket, name: string): void {
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/name', params: { name } }));
    } catch {
      // closing: the next connection's hello gets it
    }
  }

  // An arm asks the hub to fetch a public URL for it (chrome-bridge's cloud
  // upload): see download.ts for why the browser must not fetch it itself.
  private downloads = 0;
  private async download(ws: WebSocket, id: string | number, params: Record<string, unknown>): Promise<void> {
    const answer = (body: Record<string, unknown>) => {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
      } catch {
        // the arm went away; nothing to tell
      }
    };
    if (this.downloads >= 2) return answer({ error: { code: -32000, message: 'Cloud Bridge is already downloading two files for you; upload them one call at a time' } });
    this.downloads++;
    try {
      answer({ result: { ...(await downloadPublic(String(params.url ?? ''))) } });
    } catch (error) {
      answer({ error: { code: -32000, message: (error as Error).message } });
    } finally {
      this.downloads--;
    }
  }

  // An arm hands over a file it made for the user (chrome-bridge's fetch --out,
  // net --har): kept an hour, answered with a link only this account can open.
  private async keepFile(ws: WebSocket, att: Attachment, id: string | number, params: Record<string, unknown>): Promise<void> {
    const answer = (body: Record<string, unknown>) => {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
      } catch {
        // the arm went away; nothing to tell
      }
    };
    const refuse = (message: string) => answer({ error: { code: -32000, message } });
    // Sockets accepted before userId rode the attachment survive a deploy (found live).
    const userId = att.userId ?? this.ctx.id.name ?? this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'user'").toArray()[0]?.value;
    if (!userId) return refuse("Cloud Bridge couldn't tell whose file this is, so nothing was kept; run the command without --out/--har (the result comes back inline), or try again in a minute");
    let bytes: Uint8Array;
    if (typeof params.text === 'string') bytes = new TextEncoder().encode(params.text);
    else if (typeof params.data === 'string') {
      if (params.data.length > Math.ceil(FILE_MAX / 3) * 4 + 4) return refuse(`the file is over ${FILE_MAX / 1048576} MB — Cloud Bridge keeps files up to ${FILE_MAX / 1048576} MB`);
      try {
        bytes = Uint8Array.from(atob(params.data), (c) => c.charCodeAt(0));
      } catch {
        return refuse('data must be base64');
      }
    } else return refuse('send the file as text or as base64 data');
    if (bytes.length > FILE_MAX) return refuse(`the file is ${(bytes.length / 1048576).toFixed(1)} MB — Cloud Bridge keeps files up to ${FILE_MAX / 1048576} MB`);
    const now = Date.now();
    this.sql.exec('DELETE FROM files WHERE ts < ?', now - 86400_000);
    const kept = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM files').one().n;
    if (kept >= FILES_PER_DAY) return refuse(`Cloud Bridge already kept ${FILES_PER_DAY} files for this account in the last 24 hours; the result itself still comes back without --out/--har`);
    // Each file is a KV write, and free KV takes 1,000 a day for every user together.
    // The account's row is taken first: the await below lets other calls in.
    const reserved = this.sql.exec<{ id: number }>('INSERT INTO files(ts, size) VALUES (?, ?) RETURNING rowid AS id', now, bytes.length).one().id;
    let allowed: boolean;
    try {
      allowed = await takeQuota(this.env, `files:${Math.floor(now / DAY_MS)}`, FILES_PER_DAY_ALL, (Math.floor(now / DAY_MS) + 1) * DAY_MS);
    } catch (error) {
      if (this.has()) this.sql.exec('DELETE FROM files WHERE rowid = ?', reserved);
      return refuse(`Cloud Bridge couldn't keep the file (${(error as Error).message}); try again, or run it without --out/--har`);
    }
    // The account was deleted while the quota was checked: keep nothing for it.
    if (!this.has()) return refuse('this Cloud Bridge account was just deleted, so nothing was kept');
    if (!allowed) {
      this.sql.exec('DELETE FROM files WHERE rowid = ?', reserved);
      return refuse(filesTodayText(now));
    }
    const mimeType = typeof params.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(params.mimeType) ? params.mimeType : 'application/octet-stream';
    try {
      const file = await putFile(this.env.OAUTH_KV, userId, new URL(this.env.MCP_RESOURCE).origin, safeName(params.name), mimeType, bytes, now);
      answer({ result: { ...file, expiresAt: new Date(file.expires).toISOString() } });
    } catch (error) {
      refuse(`Cloud Bridge couldn't keep the file (${(error as Error).message}); try again, or run it without --out/--har`);
    }
  }

  // Reads go through here, never straight from the Worker: KV shows a write at
  // once only in the location that made it (this object's), while elsewhere a
  // fresh key can read as missing for a minute — an AI app's resources/read
  // right after the command would have been told the link expired (review).
  async readFile(userId: string, id: string): Promise<{ bytes: ArrayBuffer; meta: FileMeta } | null> {
    return getFile(this.env.OAUTH_KV, userId, id);
  }

  private request(ws: WebSocket, connId: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const timeoutMs = Number(this.env.ARM_CALL_TIMEOUT_MS) || 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ArmSilent(`the arm didn't answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { connId, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`the arm's connection is closed (${(error as Error).message})`));
      }
    });
  }

  // Open, ready and still pinging. A silent socket is closed here, so the arm's
  // own reconnect takes over and AI apps see it offline instead of hanging.
  private live(ws: WebSocket, now = Date.now()): Attachment | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.ready || ws.readyState !== WebSocket.OPEN) return null;
    const heard = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, att.since ?? 0);
    if (now - heard <= HEARTBEAT_STALE_MS) return att;
    this.gone(ws, 'stopped sending heartbeats', heard);
    try {
      ws.close(4003, 'no heartbeat: reconnect');
    } catch {
      // already closed
    }
    return null;
  }

  private arms(): ArmInfo[] {
    if (!this.has()) return [];
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.live(ws);
      if (att) online.add(att.armId);
    }
    return this.sql.exec<ArmRow>('SELECT * FROM arms ORDER BY created_at').toArray().map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      online: online.has(r.id),
      lastSeen: r.last_seen,
      tools: r.tools ? (JSON.parse(r.tools) as ArmTool[]) : [],
      selector: r.selector ?? 'arm',
      offlineHint: r.offline_hint,
    }));
  }

  async listTools(): Promise<HubTool[]> {
    return buildToolList(this.arms());
  }

  // Calls still waiting for their arm: activity records a call when it ends,
  // so a burst of parallel calls would otherwise all pass the count.
  private calling = 0;

  // Why this call can't run now, or null. The count reads activity (one row per
  // call, ids in order, nothing written): there were `limit` calls in the window
  // when the row `limit` back from the newest is inside it. Two point reads.
  private overLimit(now: number): string | null {
    const newest = this.has() ? (this.sql.exec<{ id: number | null }>('SELECT MAX(id) AS id FROM activity').one().id ?? 0) : 0;
    for (const [limit, window, text] of [
      [CALLS_PER_DAY, DAY_MS, callsPerDayText],
      [CALLS_PER_MINUTE, MINUTE_MS, callsPerMinuteText],
    ] as const) {
      const back = limit - this.calling;
      if (back <= 0) return text(window);
      if (newest - back + 1 < 1) continue;
      const ts = this.sql.exec<{ ts: number }>('SELECT ts FROM activity WHERE id = ?', newest - back + 1).toArray()[0]?.ts;
      if (ts !== undefined && ts > now - window) return text(ts + window - now);
    }
    return null;
  }

  async callTool(name: string, args: Record<string, unknown>, meta: CallMeta = {}): Promise<ToolResult> {
    const started = Date.now();
    // Not recorded: a refused call writes nothing, so a runaway client can't spend rows on refusals.
    const limited = this.overLimit(started);
    if (limited) return { content: [{ type: 'text', text: limited }], isError: true };
    const resolved = resolveCall(this.arms(), name, args, started);
    if (!resolved.ok) {
      this.record(meta, null, name, false, Date.now() - started, resolved.note);
      return { content: [{ type: 'text', text: resolved.error }], isError: true };
    }
    const { arm, tool } = resolved;
    const ws = this.ctx.getWebSockets(arm.id).find((s) => this.live(s));
    if (!ws) return { content: [{ type: 'text', text: `The ${arm.kind} "${arm.name}" just went offline. Call this tool again in a few seconds.` }], isError: true };
    this.calling++;
    try {
      const result = await this.request(ws, (ws.deserializeAttachment() as Attachment).connId, 'tools/call', { name: tool, arguments: resolved.args, _meta: { client: meta.client, session: meta.session } });
      const content = Array.isArray(result.content) ? (result.content as ToolResult['content']) : [{ type: 'text', text: JSON.stringify(result) }];
      const isError = result.isError === true;
      // Never the arm's own error text: it can echo the command line (a chrome_batch
      // "$ fill … -- <secret>") or page content. Metadata only.
      this.record(meta, arm.id, name, !isError, Date.now() - started, isError ? ARM_ERROR : null, reportedActivity(result._meta), content);
      return { content, isError };
    } catch (error) {
      const text = `The ${arm.kind} "${arm.name}" failed on ${name}: ${(error as Error).message}. The command may or may not have run: check the current state before retrying.`;
      // Activity keeps plain words for the person, never the arm's own text.
      const who = armLabel(arm.kind, arm.name);
      const note = error instanceof ArmAnswer ? ARM_ERROR : error instanceof ArmSilent ? `${who} didn't answer in time, so it may or may not have done this step.` : `${who} lost its connection before answering, so it may or may not have done this step.`;
      this.record(meta, arm.id, name, false, Date.now() - started, note);
      return { content: [{ type: 'text', text }], isError: true };
    } finally {
      this.calling--; // in the same step as its activity row: the count never sees it twice or not at all
    }
  }

  // Metadata, plus the arm's reported details while the person keeps them:
  // never the AI app's arguments or the result's text as such.
  private record(meta: CallMeta, armId: string | null, command: string, ok: boolean, ms: number, error: string | null, report: Report = NO_REPORT, content: ContentBlock[] = []): void {
    // A call that waited on an arm while the account was deleted: nothing to keep.
    if (armId && !this.has()) return;
    this.ensure(); // a signed-in user's call: their hub may keep rows now
    const id = this.sql
      .exec<{ id: number }>(
        'INSERT INTO activity(ts, session, client, client_name, arm_id, command, verb, target_host, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        Date.now(),
        meta.session ?? null,
        meta.client ?? null,
        meta.clientName?.slice(0, 100) || null,
        armId,
        command,
        report.command,
        report.site,
        ok ? 1 : 0,
        ms,
        error ? error.slice(0, 500) : null,
      )
      .one().id;
    this.prune(Date.now());
    this.sql.exec('DELETE FROM details WHERE activity_id < (SELECT MIN(id) FROM activity)');
    if (this.keepingDetails()) this.keepDetails(id, report, content);
    this.broadcast(this.activityWhere('a.id = ?', [id], 1));
  }

  keepingDetails(): boolean {
    return this.has() && this.sql.exec("SELECT 1 FROM settings WHERE key = 'keep_details' AND json = 'true'").toArray().length > 0;
  }

  private keepDetails(id: number, report: Report, content: ContentBlock[]): void {
    const shot = content.find((c) => c.type === 'image' && typeof c.data === 'string' && IMAGE_TYPES.test(c.mimeType ?? ''));
    let image: Uint8Array | null = null;
    let tooBig = false;
    if (shot) {
      if (shot.data!.length * 0.75 > IMAGE_MAX + 4) tooBig = true;
      else {
        try {
          image = Uint8Array.from(atob(shot.data!), (c) => c.charCodeAt(0));
        } catch {
          // not base64: nothing to show
        }
        if (image && image.length > IMAGE_MAX) [image, tooBig] = [null, true];
      }
    }
    if (!report.line && !report.preview && !image && !tooBig) return;
    const enc = new TextEncoder();
    const bytes = enc.encode(report.line ?? '').length + enc.encode(report.preview ?? '').length + (image?.length ?? 0);
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO details(activity_id, ts, line, preview, image, image_type, image_too_big, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      now,
      report.line,
      report.preview,
      image ? image.buffer : null,
      image ? shot!.mimeType! : null,
      tooBig ? 1 : 0,
      bytes,
    );
    // Over the account's cap: the oldest kept details make room, down to 80% so
    // this scan of every kept row runs now and then, not on every call.
    if (this.detailsBytes(bytes) > DETAILS_CAP) {
      this.sql.exec(
        `UPDATE details SET line = NULL, preview = NULL, image = NULL, image_type = NULL, bytes = 0, dropped = 1 WHERE activity_id IN
          (SELECT activity_id FROM (SELECT activity_id, SUM(bytes) OVER (ORDER BY activity_id DESC) AS total FROM details WHERE dropped = 0) WHERE total > ?)`,
        DETAILS_CAP * 0.8,
      );
      this.recountDetails();
    }
    void this.sweepLater(sweepAt(now));
  }

  // The kept bytes, as a running total (summing the table on every call read every row).
  private detailsBytes(add = 0): number {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM settings WHERE key = 'details_bytes'").toArray()[0];
    const total = (row ? Number(row.json) : 0) + add;
    if (add) this.sql.exec("INSERT OR REPLACE INTO settings(key, json) VALUES ('details_bytes', ?)", String(total));
    return total;
  }

  private recountDetails(): void {
    const total = this.sql.exec<{ n: number | null }>('SELECT SUM(bytes) AS n FROM details').one().n ?? 0;
    this.sql.exec("INSERT OR REPLACE INTO settings(key, json) VALUES ('details_bytes', ?)", String(total));
  }

  // Details last a day even when no call comes to clear them: the alarm does,
  // at most hourly, so it clears a batch per run (an alarm per kept step would
  // wake the object as often as the calls themselves).
  private async sweepLater(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
  }

  // Ids follow time, so the expired details are the ones before the first fresh
  // one: range reads on the key, proportional to what goes.
  async alarm(): Promise<void> {
    if (!this.has()) return;
    const fresh = this.sql.exec<{ id: number }>('SELECT activity_id AS id FROM details WHERE ts > ? ORDER BY activity_id LIMIT 1', Date.now() - DETAILS_MS).toArray()[0];
    const before = fresh ? fresh.id : Number.MAX_SAFE_INTEGER;
    const freed = this.sql.exec<{ n: number | null }>('SELECT SUM(bytes) AS n FROM details WHERE activity_id < ?', before).one().n ?? 0;
    this.sql.exec('DELETE FROM details WHERE activity_id < ?', before);
    if (freed) this.detailsBytes(-freed);
    const next = this.sql.exec<{ ts: number }>('SELECT ts FROM details ORDER BY activity_id LIMIT 1').toArray()[0];
    if (next) await this.ctx.storage.setAlarm(sweepAt(next.ts));
  }

  // The switch on the Activity page. Off deletes everything kept, at once.
  async setKeepDetails(on: boolean): Promise<void> {
    this.ensure();
    if (on) this.sql.exec("INSERT OR REPLACE INTO settings(key, json) VALUES ('keep_details', 'true')");
    else {
      this.sql.exec("DELETE FROM settings WHERE key IN ('keep_details', 'details_bytes')");
      this.sql.exec('DELETE FROM details');
      await this.ctx.storage.deleteAlarm();
    }
  }

  async stepDetails(id: number): Promise<StepDetails | null> {
    if (!this.has()) return null;
    const row = this.sql
      .exec<{ line: string | null; preview: string | null; has_image: number; image_too_big: number }>(
        'SELECT line, preview, image IS NOT NULL AS has_image, image_too_big FROM details WHERE activity_id = ? AND dropped = 0 AND ts > ?',
        id,
        Date.now() - DETAILS_MS,
      )
      .toArray()[0];
    return row ? { line: row.line, preview: row.preview, image: !!row.has_image, imageTooBig: !!row.image_too_big } : null;
  }

  async stepImage(id: number): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    if (!this.has()) return null;
    const row = this.sql.exec<{ image: ArrayBuffer | null; image_type: string | null }>('SELECT image, image_type FROM details WHERE activity_id = ? AND dropped = 0 AND ts > ?', id, Date.now() - DETAILS_MS).toArray()[0];
    return row?.image && row.image_type ? { bytes: row.image, type: row.image_type } : null;
  }

  // A batch script from the given steps, oldest first: each kept line as is,
  // every other step as a comment saying what it was.
  async stepScript(ids: number[]): Promise<{ steps: number; kept: number; text: string }> {
    if (!this.has() || !ids.length) return { steps: 0, kept: 0, text: '' };
    const rows = this.sql
      .exec<{ id: number; ts: number; tool: string; verb: string | null; site: string | null; line: string | null }>(
        `SELECT a.id, a.ts, a.command AS tool, a.verb, a.target_host AS site, d.line FROM activity a
          LEFT JOIN details d ON d.activity_id = a.id AND d.dropped = 0 AND d.ts > ? WHERE a.id IN (SELECT value FROM json_each(?)) ORDER BY a.id`,
        Date.now() - DETAILS_MS,
        JSON.stringify(ids),
      )
      .toArray();
    let kept = 0;
    const out = rows.map((r) => {
      if (r.line) {
        kept++;
        return r.line;
      }
      const what = (r.verb ?? r.tool) + (r.site ? ` on ${r.site}` : '');
      return `# ${new Date(r.ts).toISOString()} ${what}: details not kept`;
    });
    return { steps: rows.length, kept, text: out.join('\n') };
  }

  // Keeps 30 days, at most the newest 5,000 (CALLS_PER_DAY counts these rows, so
  // it can't be higher). Two range deletes on the id: the one "ts < ? OR id <= …"
  // read every row on every call (5,000 a call against the Free plan's rows-read
  // budget, shared by every account). The row just written keeps the subquery
  // from being empty. Returns the rows read, so a test can hold it to a constant.
  prune(now: number): number {
    const capped = this.sql.exec('DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - 5000');
    capped.toArray();
    const aged = this.sql.exec('DELETE FROM activity WHERE id < (SELECT id FROM activity WHERE ts >= ? ORDER BY id LIMIT 1)', now - 30 * 86400_000);
    aged.toArray();
    return capped.rowsRead + aged.rowsRead;
  }

  // Open Activity pages get each row as it's written.
  private broadcast(rows: ActivityView[]): void {
    if (!rows.length) return;
    const frame = JSON.stringify({ rows });
    for (const ws of this.ctx.getWebSockets(VIEWER)) {
      try {
        ws.send(frame);
      } catch {
        // closing; the page reconnects and asks for what it missed
      }
    }
  }

  // GET /app/activity/live (signed in, the hub's own page): a hibernatable socket
  // tagged VIEWER. It gets the rows after `after` (what the page missed while it
  // loaded or reconnected; 0 for a page that had none), then each new one. The oldest page beyond VIEWERS_MAX closes.
  private watch(after: number): Response {
    const open = this.ctx.getWebSockets(VIEWER);
    const extra = open.length - VIEWERS_MAX + 1;
    if (extra > 0) {
      const oldest = open.sort((a, b) => (a.deserializeAttachment() as ViewerAttachment).since - (b.deserializeAttachment() as ViewerAttachment).since);
      for (const ws of oldest.slice(0, extra)) {
        try {
          ws.close(4000, 'Activity is open in too many tabs: this one stopped updating');
        } catch {
          // already closed
        }
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [VIEWER]);
    server.serializeAttachment({ viewer: true, since: Date.now() } satisfies ViewerAttachment);
    // More missed than one frame should carry: the page reloads its rows instead
    // of keeping a hole (it only pages backwards from its oldest row).
    const missed = this.activityWhere('a.id > ?', [after], CATCH_UP_MAX + 1);
    if (missed.length > CATCH_UP_MAX) server.send(JSON.stringify({ rows: [], reset: true }));
    else if (missed.length) server.send(JSON.stringify({ rows: missed.reverse() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private activityWhere(where: string, params: unknown[], limit: number): ActivityView[] {
    if (!this.has()) return [];
    return this.sql
      .exec<ActivityView>(
        `SELECT a.id, a.ts, a.client, a.client_name AS clientName, r.name AS profile, (a.arm_id IS NOT NULL AND r.id IS NULL) AS profileGone,
          a.command AS tool, a.verb AS command, a.target_host AS site, a.ok, a.ms, a.error,
          CASE WHEN d.activity_id IS NULL THEN 0 WHEN d.dropped = 1 THEN 2 ELSE 1 END AS details
        FROM activity a LEFT JOIN arms r ON r.id = a.arm_id LEFT JOIN details d ON d.activity_id = a.id AND d.ts > ?
        WHERE ${where} ORDER BY a.id DESC LIMIT ?`,
        Date.now() - DETAILS_MS,
        ...params,
        limit,
      )
      .toArray()
      .map((row) => ({ ...row, error: row.error === ARM_ERROR ? null : row.error }));
  }

  // The Activity page: newest first, `limit` rows before the id `before` (0: the newest).
  async activityRows(before = 0, limit = 300): Promise<{ rows: ActivityView[]; more: boolean }> {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 300));
    const rows = before > 0 ? this.activityWhere('a.id < ?', [before], n + 1) : this.activityWhere('1 = 1', [], n + 1);
    return { rows: rows.slice(0, n), more: rows.length > n };
  }

  async recentActivity(limit = 50): Promise<ActivityRow[]> {
    if (!this.has()) return [];
    return this.sql.exec<ActivityRow>('SELECT ts, client, arm_id, command, ok, ms, error FROM activity ORDER BY id DESC LIMIT ?', limit).toArray();
  }
}

// Stored instead of an arm's error text (which may carry arguments or page content).
export const ARM_ERROR = 'the arm reported an error';

// A JSON-RPC error the arm answered with: its message is the arm's text, so the
// caller may read it but activity must not keep it (as with isError results).
class ArmAnswer extends Error {}
// The arm said nothing before the call's timeout.
class ArmSilent extends Error {}
