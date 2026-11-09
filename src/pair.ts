import { requireSession, type HubEnv } from './auth';
import { validArm } from './hub';
import { addSteps, COPY_SCRIPT } from './guide';
import { armLabel, codeWhere, connectWhere } from './kinds';
import { escapeHtml, json, page, randomToken, sha256, sign, verify } from './util';

// Device-code pairing, any arm kind:
//   arm  POST /pair/start {kind, name}       → {code, pollToken, verificationUri, interval, expiresIn}
//   user GET  /pair?code=…  (signs in)       → Approve / Deny
//   arm  POST /pair/poll {code, pollToken}   → pending | approved {armToken, armUrl} | expired
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const TTL = 600;

interface PairRecord {
  kind: string;
  name: string;
  pollHash: string;
  status: 'pending' | 'approved' | 'denied';
  armToken?: string;
  expires: number;
}

function newCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(r, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

function normCode(code: unknown): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}

const key = (code: string) => `pair:${code}`;

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function pairStart(request: Request, env: Env): Promise<Response> {
  const { kind, name } = await body(request);
  const bad = validArm(kind, name);
  if (bad) return json({ error: 'invalid_request', message: `${bad}. Send {"kind":"chrome","name":"<profile>"}.` }, 400);
  const code = newCode();
  const pollToken = randomToken(32);
  const record: PairRecord = { kind: kind as string, name: (name as string).trim(), pollHash: await sha256(pollToken), status: 'pending', expires: Date.now() + TTL * 1000 };
  await env.OAUTH_KV.put(key(code), JSON.stringify(record), { expirationTtl: TTL });
  const verificationUri = new URL(`/pair?code=${code}`, request.url).href;
  return json({ code, pollToken, verificationUri, interval: 3, expiresIn: TTL });
}

export async function pairPoll(request: Request, env: Env): Promise<Response> {
  const { code: raw, pollToken } = await body(request);
  const code = normCode(raw);
  const record = await env.OAUTH_KV.get<PairRecord>(key(code), 'json');
  if (!record || record.expires < Date.now() || typeof pollToken !== 'string' || record.pollHash !== (await sha256(pollToken))) {
    return json({ status: 'expired', message: 'This pairing code expired or is unknown. Start pairing again (POST /pair/start).' }, 404);
  }
  if (record.status === 'pending') return json({ status: 'pending', message: 'Waiting for the user to approve at the verification URL.' });
  await env.OAUTH_KV.delete(key(code));
  if (record.status === 'denied') return json({ status: 'denied', message: 'The user denied this pairing. Start again only if they ask you to.' }, 403);
  const armUrl = new URL('/arm', request.url);
  armUrl.protocol = armUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return json({ status: 'approved', armToken: record.armToken, armUrl: armUrl.href });
}

// The form's CSRF token: bound to this signed-in user and this code.
const csrfFor = (uid: string, code: string, secret: string) => sign(`pair|${uid}|${code}`, secret);

export async function pairPage(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const code = normCode(new URL(request.url).searchParams.get('code'));
  const record = await env.OAUTH_KV.get<PairRecord>(key(code), 'json');
  if (!record || record.status !== 'pending') return expired();
  const csrf = await csrfFor(session.uid, code, env.COOKIE_ENCRYPTION_KEY);
  return page(
    `Connect ${armLabel(record.kind, record.name)}?`,
    `<p>Did you just click <strong>Connect</strong> in ${escapeHtml(connectWhere(record.kind))}? Then click Connect below. If you didn't, click Deny: someone else may be trying to link their browser to your account.</p>
<p class="note">Code <code>${escapeHtml(code)}</code>. ${escapeHtml(codeWhere(record.kind))} shows the same code while it waits.</p>
<p>Once connected, Claude, ChatGPT and other AI apps you allow can use it as <strong>@${escapeHtml(session.login)}</strong>.</p>
<form method="post" action="/pair/approve"><input type="hidden" name="code" value="${escapeHtml(code)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<p><button name="decision" value="approve">Connect</button> <button class="secondary" name="decision" value="deny">Deny</button></p></form>`,
  );
}

const expired = () =>
  page('This code expired', '<p>It expired or was already used. Start again where you got it (for Chrome: the chrome-bridge popup → ⚙ Settings → Cloud AI apps).</p>', { status: 404 });

export async function pairApprove(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const form = await request.formData();
  const code = normCode(form.get('code'));
  if (!(await verify(`pair|${session.uid}|${code}`, String(form.get('csrf') ?? ''), env.COOKIE_ENCRYPTION_KEY))) {
    return page('Not connected', '<p>This page is out of date or came from another site, so nothing was connected. Start again from the chrome-bridge popup (⚙ Settings → Cloud AI apps).</p>', { status: 403 });
  }
  const record = await env.OAUTH_KV.get<PairRecord>(key(code), 'json');
  if (!record || record.status !== 'pending' || record.expires < Date.now()) return expired();
  const ttl = Math.max(60, Math.ceil((record.expires - Date.now()) / 1000));
  if (form.get('decision') !== 'approve') {
    await env.OAUTH_KV.put(key(code), JSON.stringify({ ...record, status: 'denied' }), { expirationTtl: ttl });
    return page('Not connected', '<p>Nothing was connected. You can close this tab.</p>');
  }
  const hub = env.USER_HUB.get(env.USER_HUB.idFromName(session.uid));
  const { token } = await hub.createArm(session.uid, record.kind, record.name);
  await env.OAUTH_KV.put(key(code), JSON.stringify({ ...record, status: 'approved', armToken: token }), { expirationTtl: ttl });
  // Not a dead end: the next step is adding Cloud Bridge to an AI app.
  return page(
    `${armLabel(record.kind, record.name)} is connected`,
    `<p><strong>Already added Cloud Bridge to Claude or ChatGPT? You're done: you can close this tab.</strong></p>
<h2>Next: add Cloud Bridge to your AI app</h2>
${addSteps(request.url)}`,
    { script: COPY_SCRIPT, icon: '✅' },
  );
}
