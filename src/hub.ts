import { DurableObject } from 'cloudflare:workers';
import { buildToolList, resolveCall, type ArmInfo, type ArmTool, type HubTool } from './tools';
import { randomToken, sha256, b64url } from './util';

export const ARM_PROTOCOL = 'cloud-bridge.v1';
const ARM_KINDS = /^[a-z][a-z0-9-]{0,23}$/;

interface Attachment {
  armId: string;
  // One per socket: a replaced connection's late close must not fail calls on its successor.
  connId: string;
  ready: boolean; // hello received and tools listed
}

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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS arms(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version TEXT, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen INTEGER, tools TEXT, selector TEXT, offline_hint TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS activity(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, client TEXT, arm_id TEXT, command TEXT NOT NULL,
      target_host TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, result_ref TEXT)`);
    // Heartbeats are answered without waking the object (no free-tier request spent).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async createArm(userId: string, kind: string, name: string): Promise<{ armId: string; token: string }> {
    const armId = crypto.randomUUID();
    const token = `cba_${b64url(new TextEncoder().encode(userId))}.${randomToken(32)}`;
    this.sql.exec('INSERT INTO arms(id, kind, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', armId, kind, name.trim(), await sha256(token), Date.now());
    return { armId, token };
  }

  // The /arm WebSocket upgrade, forwarded by the worker with the token in x-arm-token.
  async fetch(request: Request): Promise<Response> {
    const token = request.headers.get('x-arm-token') ?? '';
    const row = this.sql.exec<ArmRow>('SELECT * FROM arms WHERE token_hash = ?', await sha256(token)).toArray()[0];
    if (!row) return refuse(request, 'unknown or revoked arm token: pair this arm again');
    for (const old of this.ctx.getWebSockets(row.id)) old.close(4000, 'replaced by a newer connection of the same arm');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [row.id]);
    server.serializeAttachment({ armId: row.id, connId: crypto.randomUUID(), ready: false } satisfies Attachment);
    this.sql.exec('UPDATE arms SET last_seen = ? WHERE id = ?', Date.now(), row.id);
    const headers = new Headers();
    if (request.headers.get('Sec-WebSocket-Protocol')) headers.set('Sec-WebSocket-Protocol', ARM_PROTOCOL);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: send JSON-RPC 2.0 text frames' } }));
      return;
    }
    if (msg.method === 'arm/hello') return this.hello(ws, att, msg.params ?? {});
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

  private async hello(ws: WebSocket, att: Attachment, params: Record<string, unknown>): Promise<void> {
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
      ws.serializeAttachment({ ...att, ready: true } satisfies Attachment);
    } catch (error) {
      try {
        ws.close(4002, `tools/list failed: ${(error as Error).message}`.slice(0, 120));
      } catch {
        // the socket itself is what failed
      }
    }
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

  private arms(): ArmInfo[] {
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.ready && ws.readyState === WebSocket.OPEN) online.add(att.armId);
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

  async callTool(name: string, args: Record<string, unknown>, meta: CallMeta = {}): Promise<ToolResult> {
    const started = Date.now();
    const resolved = resolveCall(this.arms(), name, args, started);
    if (!resolved.ok) {
      this.record(meta, null, name, false, Date.now() - started, resolved.error);
      return { content: [{ type: 'text', text: resolved.error }], isError: true };
    }
    const { arm, tool } = resolved;
    const ws = this.ctx.getWebSockets(arm.id).find((s) => (s.deserializeAttachment() as Attachment | null)?.ready && s.readyState === WebSocket.OPEN);
    if (!ws) return { content: [{ type: 'text', text: `The ${arm.kind} "${arm.name}" just went offline. Call this tool again in a few seconds.` }], isError: true };
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
    }
  }

  // Metadata only: never arguments or results (opt-in result storage is D2).
  private record(meta: CallMeta, armId: string | null, command: string, ok: boolean, ms: number, error: string | null): void {
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
    this.sql.exec('DELETE FROM activity WHERE ts < ? OR id <= (SELECT MAX(id) FROM activity) - 5000', Date.now() - 30 * 86400_000);
  }

  async recentActivity(limit = 50): Promise<ActivityRow[]> {
    return this.sql.exec<ActivityRow>('SELECT ts, client, arm_id, command, ok, ms, error FROM activity ORDER BY id DESC LIMIT ?', limit).toArray();
  }
}

// Stored instead of an arm's error text (which may carry arguments or page content).
export const ARM_ERROR = 'the arm reported an error';
