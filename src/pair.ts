import { requireSession, type HubEnv } from './auth';
import { validArm } from './hub';
import { addSteps, COPY_SCRIPT } from './guide';
import { armLabel, codeWhere, connectWhere } from './kinds';
import { swapText } from './store';
import { escapeHtml, json, page, randomToken, sha256, sign, verify } from './util';

// Device-code pairing, any arm kind:
//   arm  POST /pair/start {kind, name}       → {code, pollToken, verificationUri, interval, expiresIn}
//   user GET  /pair?code=…  (signs in)       → Approve / Deny
//   arm  POST /pair/poll {code, pollToken}   → pending | approved {armToken, armUrl} | expired
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
// A code someone else started is a phishing lure: the shorter it lives, the
// less time to talk the victim into clicking Connect (S2c; was 10 minutes).
const TTL = 300;

// Roughly where a request came from, per Cloudflare's IP geolocation. No address is kept.
export interface Place {
  city?: string;
  region?: string;
  country?: string;
}

interface PairRecord {
  kind: string;
  name: string;
  started?: number; // records from before S2c have neither
  from?: Place;
  pollHash: string;
  // approving: claimed by one Connect click while its arm record is made.
  status: 'pending' | 'approving' | 'approved' | 'denied';
  by?: string; // the hub user who clicked Connect
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

export function placeOf(request: Request): Place {
  const cf = (request.cf ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);
  const country = text(cf.country)?.toUpperCase();
  return { city: text(cf.city), region: text(cf.region), country: country === 'XX' ? undefined : country };
}

function countryName(code: string): string {
  if (code === 'T1') return 'the Tor network';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// "around Seattle, United States" (read after "from"), or undefined when Cloudflare didn't say.
export function placeText(place: Place | undefined): string | undefined {
  if (!place?.country) return place?.city || place?.region ? `around ${place.city ?? place.region}` : undefined;
  if (place.country === 'T1') return 'the Tor network';
  return `around ${[place.city ?? place.region, countryName(place.country)].filter(Boolean).join(', ')}`;
}

export function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'less than a minute ago' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

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
  const now = Date.now();
  const record: PairRecord = { kind: kind as string, name: (name as string).trim(), started: now, from: placeOf(request), pollHash: await sha256(pollToken), status: 'pending', expires: now + TTL * 1000 };
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
  if (record.status === 'pending' || record.status === 'approving') return json({ status: 'pending', message: 'Waiting for the user to approve at the verification URL.' });
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
  if (!record || record.status !== 'pending' || record.expires < Date.now()) return expired();
  const csrf = await csrfFor(session.uid, code, env.COOKIE_ENCRYPTION_KEY);
  // Whoever clicked Connect opens this page from the same browser, so from the
  // same network: a request from another country is someone else's (S2c).
  const there = record.from;
  const here = placeOf(request);
  const elsewhere = Boolean(there?.country && here.country && there.country !== here.country);
  const where = placeText(there);
  const when = record.started ? `Started ${agoText(Date.now() - record.started)}${where ? `, from ${where}` : ''}. ` : '';
  const warning = elsewhere
    ? `<p class="warn"><strong>Careful: this didn't start where you are.</strong> It started from ${escapeHtml(placeText(there)!)}, and this page opened from ${escapeHtml(placeText(here)!)}. Click Deny unless you're sure you just clicked Connect yourself.</p>\n`
    : '';
  const [connect, deny] = elsewhere ? [' class="secondary"', ''] : ['', ' class="secondary"'];
  return page(
    `Connect ${armLabel(record.kind, record.name)}?`,
    `${warning}<p>Did you just click <strong>Connect</strong> in ${escapeHtml(connectWhere(record.kind))}? Then click Connect below. If you didn't, click Deny: someone else may be trying to link their browser to your account.</p>
<p class="note">${escapeHtml(when)}Code <code>${escapeHtml(code)}</code>. ${escapeHtml(codeWhere(record.kind))} shows the same code while it waits.</p>
<p>Once connected, Claude, ChatGPT and other AI apps you allow can use it as <strong>@${escapeHtml(session.login)}</strong>.</p>
<form method="post" action="/pair/approve"><input type="hidden" name="code" value="${escapeHtml(code)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<p><button${connect} name="decision" value="approve">Connect</button> <button${deny} name="decision" value="deny">Deny</button></p></form>`,
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
  const raw = await env.OAUTH_KV.get(key(code));
  const record = raw === null ? null : (JSON.parse(raw) as PairRecord);
  if (!record || record.expires < Date.now()) return expired();
  // A double-click submits twice, and the second answer is the one on screen.
  if (record.by === session.uid && (record.status === 'approving' || record.status === 'approved')) return connected(request, record);
  if (record.status !== 'pending' || raw === null) return expired();
  const ttl = Math.max(60, Math.ceil((record.expires - Date.now()) / 1000));
  if (form.get('decision') !== 'approve') {
    if (!(await swapText(env, key(code), raw, JSON.stringify({ ...record, status: 'denied' }), ttl))) return expired();
    return page('Not connected', '<p>Nothing was connected. You can close this tab.</p>');
  }
  // Claimed before the arm record exists: two approvals that both read "pending"
  // made two records, and the one whose token was overwritten stayed offline in
  // every AI app's list for good (S1).
  const claimed = JSON.stringify({ ...record, status: 'approving', by: session.uid });
  if (!(await swapText(env, key(code), raw, claimed, ttl))) {
    const now = await env.OAUTH_KV.get<PairRecord>(key(code), 'json');
    return now?.by === session.uid && (now.status === 'approving' || now.status === 'approved') ? connected(request, now) : expired();
  }
  const hub = env.USER_HUB.get(env.USER_HUB.idFromName(session.uid));
  let token: string;
  try {
    ({ token } = await hub.createArm(session.uid, record.kind, record.name));
  } catch (error) {
    await swapText(env, key(code), claimed, raw, ttl); // back to pending: Connect again works
    throw error;
  }
  await env.OAUTH_KV.put(key(code), JSON.stringify({ ...record, status: 'approved', by: session.uid, armToken: token }), { expirationTtl: ttl });
  return connected(request, record);
}

// Not a dead end: the next step is adding Cloud Bridge to an AI app.
function connected(request: Request, record: PairRecord): Response {
  return page(
    `${armLabel(record.kind, record.name)} is connected`,
    `<p><strong>Already added Cloud Bridge to Claude or ChatGPT? You're done: you can close this tab.</strong></p>
<h2>Next: add Cloud Bridge to your AI app</h2>
${addSteps(request.url)}`,
    { script: COPY_SCRIPT, icon: '✅' },
  );
}
