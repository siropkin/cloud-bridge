import { DurableObject } from 'cloudflare:workers';
import { buildToolList, resolveCall, type ArmInfo, type ArmTool, type HubTool } from './tools';
import { randomToken, sha256, b64url } from './util';
import { downloadPublic } from './download';
import { FILE_MAX, FILES_PER_DAY, getFile, putFile, safeName, type FileMeta } from './files';
import { ARM_CONNECTS_PER_HOUR, CALLS_PER_DAY, CALLS_PER_MINUTE, DAY_MS, FILES_PER_DAY_ALL, HOUR_MS, MINUTE_MS, armConnectsText, callsPerDayText, callsPerMinuteText, filesTodayText } from './limits';
import { takeQuota } from './store';

export const ARM_PROTOCOL = 'cloud-bridge.v1';
const ARM_KINDS = /^[a-z][a-z0-9-]{0,23}$/;

interface Attachment {
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
  client?: string;
  session?: string;
}

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
      target_host TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, result_ref TEXT)`);
    // When files were kept (the bytes live in KV): the daily cap counts these.
    this.sql.exec('CREATE TABLE IF NOT EXISTS files(ts INTEGER NOT NULL, size INTEGER NOT NULL)');
    // Whose hub this is: ctx.id.name when the caller used idFromName (every caller
    // here does), kept for wakes that may lack it (a hibernated socket's message).
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (this.ctx.id.name) this.sql.exec("INSERT OR IGNORE INTO meta(key, value) VALUES ('user', ?)", this.ctx.id.name);
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

  // The /arm WebSocket upgrade, forwarded by the worker with the token in x-arm-token.
  async fetch(request: Request): Promise<Response> {
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
      if (msg.error) p.reject(new Error(msg.error.message ?? 'the arm returned an error'));
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

  private gone(ws: WebSocket, why: string): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.sql.exec('UPDATE arms SET last_seen = ? WHERE id = ?', Date.now(), att.armId);
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
      this.sql.exec('DELETE FROM files WHERE rowid = ?', reserved);
      return refuse(`Cloud Bridge couldn't keep the file (${(error as Error).message}); try again, or run it without --out/--har`);
    }
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
        reject(new Error(`the arm didn't answer within ${Math.round(timeoutMs / 1000)}s`));
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
    this.gone(ws, 'stopped sending heartbeats');
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
      this.record(meta, null, name, false, Date.now() - started, resolved.error);
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
      this.record(meta, arm.id, name, !isError, Date.now() - started, isError ? ARM_ERROR : null);
      return { content, isError };
    } catch (error) {
      const text = `The ${arm.kind} "${arm.name}" failed on ${name}: ${(error as Error).message}. The command may or may not have run: check the current state before retrying.`;
      this.record(meta, arm.id, name, false, Date.now() - started, (error as Error).message);
      return { content: [{ type: 'text', text }], isError: true };
    } finally {
      this.calling--; // in the same step as its activity row: the count never sees it twice or not at all
    }
  }

  // Metadata only: never arguments or results (opt-in result storage is D2).
  private record(meta: CallMeta, armId: string | null, command: string, ok: boolean, ms: number, error: string | null): void {
    this.ensure(); // a signed-in user's call: their hub may keep rows now
    this.sql.exec(
      'INSERT INTO activity(ts, session, client, arm_id, command, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      meta.session ?? null,
      meta.client ?? null,
      armId,
      command,
      ok ? 1 : 0,
      ms,
      error ? error.slice(0, 500) : null,
    );
    // Keeps the newest 5,000: CALLS_PER_DAY counts these rows, so it can't be higher.
    this.sql.exec('DELETE FROM activity WHERE ts < ? OR id <= (SELECT MAX(id) FROM activity) - 5000', Date.now() - 30 * 86400_000);
  }

  async recentActivity(limit = 50): Promise<ActivityRow[]> {
    if (!this.has()) return [];
    return this.sql.exec<ActivityRow>('SELECT ts, client, arm_id, command, ok, ms, error FROM activity ORDER BY id DESC LIMIT ?', limit).toArray();
  }
}

// Stored instead of an arm's error text (which may carry arguments or page content).
export const ARM_ERROR = 'the arm reported an error';
