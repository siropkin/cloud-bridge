// Rate limits: what keeps one network or one account from spending the free
// plan's daily budgets, which every user of this hub shares (100,000 Worker
// requests, 100,000 Durable Object requests and row writes, 1,000 KV writes).
import { page } from './util';

// --- Per network: the routes anyone can call without signing in ------------
// Cloudflare's Rate Limiting binding (wrangler.jsonc: SIGNIN_LIMIT 10 a minute,
// ARM_LIMIT 60 a minute), keyed by route and the caller's network. Counts are
// per Cloudflare location and approximate: this blunts floods, it isn't a
// strict quota. Checked before the OAuth library, so /register is covered too.
type Binding = 'SIGNIN_LIMIT' | 'ARM_LIMIT';
interface Rule {
  binding: Binding;
  refuse: () => Response;
}

export const RETRY_AFTER_S = 60;
const headers = () => new Headers({ 'Retry-After': String(RETRY_AFTER_S), 'Cache-Control': 'no-store' });
const json = (body: unknown) => {
  const h = headers();
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status: 429, headers: h });
};
const signInPage = () =>
  page('Too many tries', '<p>Cloud Bridge got too many sign-in requests from your network in the last minute, so it paused them for a moment.</p><p>Wait a minute, then try again.</p>', { status: 429, headers: headers() });
const accountPage = () =>
  page('Too many tries', '<p>Cloud Bridge got too many requests for this page from your network in the last minute, so it paused them for a moment. Nothing changed.</p><p>Wait a minute, then <a href="/app">open your Cloud Bridge page</a> again.</p>', { status: 429, headers: headers() });

export const LIMITED = {
  // RFC 7591 has no rate-limit error; temporarily_unavailable is the OAuth word for "try again later".
  register: { error: 'temporarily_unavailable', error_description: 'Too many apps signed up from this network in the last minute. Wait a minute, then add Cloud Bridge again.' },
  pairStart: { error: 'rate_limited', message: 'Too many connect requests from this network in the last minute. Wait a minute, then click Connect again.' },
  // RFC 8628's device-flow answer: the code is still good, poll 5 seconds slower.
  pairPoll: { status: 'slow_down', error: 'slow_down', message: 'Too many polls from this network in the last minute: the code is still waiting; keep polling, 5 seconds slower.' },
  armRevoke: { ok: false, error: 'rate_limited', message: 'Too many sign-outs from this network in the last minute: send it again after a minute.' },
  // A refused handshake, not an accepted-then-closed socket: browsers reset
  // their reconnect backoff when a socket opens, so a 4xxx close would bring
  // the arm straight back every second; a failed handshake grows the backoff.
  arm: 'Too many connections from this network in the last minute: reconnect after a minute (Retry-After).',
};

const RULES: Record<string, Rule> = {
  'POST /register': { binding: 'SIGNIN_LIMIT', refuse: () => json(LIMITED.register) },
  'GET /authorize': { binding: 'SIGNIN_LIMIT', refuse: signInPage },
  'GET /login': { binding: 'SIGNIN_LIMIT', refuse: signInPage },
  'GET /callback': { binding: 'SIGNIN_LIMIT', refuse: signInPage },
  'POST /pair/start': { binding: 'SIGNIN_LIMIT', refuse: () => json(LIMITED.pairStart) },
  'POST /pair/poll': { binding: 'ARM_LIMIT', refuse: () => json(LIMITED.pairPoll) },
  'POST /arm/revoke': { binding: 'ARM_LIMIT', refuse: () => json(LIMITED.armRevoke) },
  'GET /arm': { binding: 'ARM_LIMIT', refuse: () => new Response(LIMITED.arm, { status: 429, headers: headers() }) },
  // Signed in, but each view and change costs shared storage requests and writes
  // (the account page lists grants and reads every app's record).
  'GET /app': { binding: 'ARM_LIMIT', refuse: accountPage },
  'POST /app/rename': { binding: 'ARM_LIMIT', refuse: accountPage },
  'POST /app/disconnect': { binding: 'ARM_LIMIT', refuse: accountPage },
  'POST /app/forget': { binding: 'ARM_LIMIT', refuse: accountPage },
  'POST /app/activity/keep': { binding: 'ARM_LIMIT', refuse: accountPage },
  'POST /app/delete': { binding: 'SIGNIN_LIMIT', refuse: accountPage },
};

// One host often holds a whole IPv6 /64, so it counts as one network; an
// address ending in a dotted quad (IPv4-mapped, NAT64) counts as that IPv4.
export function network(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4) return v4[1];
  if (!addr.includes(':')) return addr;
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

// A 429 to send instead of handling the request, or null. Requests without
// CF-Connecting-IP never come through Cloudflare's edge (which always sets it,
// overwriting any the client sent): tests and in-process calls aren't counted.
export async function limitAnonymous(request: Request, env: Pick<Env, Binding>): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return null;
  const { pathname } = new URL(request.url);
  const route = pathname === '/arm' ? 'GET /arm' : `${request.method} ${pathname}`;
  const rule = RULES[route];
  if (!rule) return null;
  try {
    const { success } = await env[rule.binding].limit({ key: `${route}|${network(ip)}` });
    return success ? null : rule.refuse();
  } catch (error) {
    // The limiter failing must not take sign-in down with it.
    console.error('rate limit check failed', route, (error as Error).message);
    return null;
  }
}

// --- Per account (UserHub) ------------------------------------------------
// Tool calls count from the activity rows (no extra writes), so the daily cap
// can't exceed the 5,000 rows activity keeps.
export const CALLS_PER_MINUTE = 120;
export const CALLS_PER_DAY = 5000;
// Connections per arm and hour; the count rides the write a connection makes anyway.
export const ARM_CONNECTS_PER_HOUR = 120;
// File links for everyone together per UTC day: each is a KV write, and free
// KV takes 1,000 a day for the whole account (its day ends at 00:00 UTC).
export const FILES_PER_DAY_ALL = 800;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function inAbout(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const n = (x: number) => x.toLocaleString('en-US');

// What a model reads when its call didn't run (descriptive, with the next step).
export function callsPerMinuteText(waitMs: number): string {
  return `Cloud Bridge takes up to ${CALLS_PER_MINUTE} tool calls a minute per account, and this account made that many in the last minute, so this call didn't run. Calls work again in ${inAbout(waitMs)}; batch tools (like chrome_batch) run several commands as one call.`;
}

export function callsPerDayText(waitMs: number): string {
  return `Cloud Bridge takes up to ${n(CALLS_PER_DAY)} tool calls a day per account (it runs on a free plan that all its users share), and this account made that many in the last 24 hours, so this call didn't run. The next call works in about ${inAbout(waitMs)}. Agents on the user's own computer (chrome-bridge's command line) aren't limited by it.`;
}

export function armConnectsText(kind: string, name: string, waitMs: number): string {
  return `This ${kind} "${name}" connected ${ARM_CONNECTS_PER_HOUR} times in the last hour, the most Cloud Bridge takes; it can connect again in ${inAbout(waitMs)}.`;
}

export function filesTodayText(now: number): string {
  const midnight = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  return `Cloud Bridge kept as many files today as its free plan allows for all its users (${FILES_PER_DAY_ALL}), so nothing was kept; new links work again after 00:00 UTC (in about ${inAbout(midnight - now)}). The result itself still comes back without --out/--har`;
}
