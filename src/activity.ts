// Activity: what AI apps did in the person's Chrome, live. The account page
// (/app) shows the latest five; /app/activity shows everything kept, grouped by
// app and profile, with filters. Both pages render from one data block with one
// script and follow new rows over a socket to their UserHub (/app/activity/live).
import { readSession, type HubEnv } from './auth';
import { LIVE_PATH, type ActivityView } from './hub';
import { inlineScript, json, type InlineScript } from './util';

const hubOf = (env: Env, uid: string) => env.USER_HUB.get(env.USER_HUB.idFromName(uid));

// Rows from one app in one profile with pauses under this belong together
// (MCP runs stateless here: there is no session id to group by).
export const GROUP_GAP_MS = 10 * 60_000;
export const PAGE_ROWS = 300;
export const STRIP_ROWS = 5;
export const SCRIPT_STEPS_MAX = 500; // steps per downloaded script (the page links a group's newest)

// Plain browser JS (String.raw keeps its escapes; no backticks or "${" inside).
// Rows arrive newest first; each is { id, ts, client, clientName, profile,
// profileGone, tool, command, site, ok, ms, error, details } (details: 0 none,
// 1 kept: "Details" fetches them, 2 removed to make room).
const CODE = String.raw`(() => {
  const $ = (id) => document.getElementById(id);
  const data = JSON.parse($('activity-data').textContent);
  const full = data.mode === 'full';
  const list = $('activity-list');
  const status = $('activity-status');
  let rows = data.rows;
  let more = data.more;
  const seen = new Set(rows.map((r) => r.id));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const app = (r) => r.clientName || data.apps[r.client] || 'An AI app';
  const profile = (r) => r.profile || (r.profileGone ? 'A removed Chrome profile' : 'No Chrome profile reached');
  const what = (r) => r.command || r.tool;
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const day = (ts) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
  const step = (r, who) => {
    const li = el('li', r.ok ? 'step' : 'step bad');
    li.append(el('span', 'when', clock(r.ts)));
    if (who) li.append(el('span', 'who', app(r) + ' · ' + profile(r)));
    li.append(el('code', null, what(r)));
    if (r.site) li.append(el('span', 'site', r.site));
    li.append(el('span', 'ms', r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'));
    li.append(el('span', 'mark', r.ok ? '✓' : '✗'));
    li.title = r.ok ? 'Worked' : "Didn't work";
    if (!r.ok && r.details !== 1) li.append(el('div', 'why', r.error || "It didn't work. Cloud Bridge doesn't keep what went wrong, since that can include what was typed or what the page showed."));
    if (!r.ok && r.details === 1 && r.error) li.append(el('div', 'why', r.error));
    if (full && r.details === 1) {
      const b = el('button', 'linkish', opened.has(r.id) ? 'Hide details' : 'Details');
      b.type = 'button';
      b.onclick = () => { if (opened.has(r.id)) opened.delete(r.id); else opened.add(r.id); render(); };
      li.append(b);
      if (opened.has(r.id)) li.append(detailsBox(r));
    }
    if (full && r.details === 2) li.append(el('div', 'why gone', 'Its details were removed to make room for newer ones.'));
    return li;
  };
  const opened = new Set();
  const cache = new Map();
  const detailsBox = (r) => {
    const box = el('div', 'more');
    const got = cache.get(r.id);
    if (!got) {
      box.append(el('p', 'note', 'Loading…'));
      fetch('/app/activity/details?id=' + r.id)
        .then(async (res) => { const d = await res.json(); cache.set(r.id, res.ok ? d : { gone: d.message || "This step's details aren't kept any more." }); })
        .catch(() => cache.set(r.id, { gone: "Couldn't load the details. Reload the page (you may need to sign in again)." }))
        .then(render);
      return box;
    }
    if (got.gone) { box.append(el('p', 'note', got.gone)); return box; }
    if (got.line) { box.append(el('div', 'label', 'Command')); box.append(el('pre', null, got.line)); }
    if (got.preview) { box.append(el('div', 'label', 'What it answered')); box.append(el('pre', null, got.preview)); }
    if (got.image) { const img = el('img'); img.src = '/app/activity/image?id=' + r.id; img.alt = 'Screenshot from this step'; box.append(img); }
    if (got.imageTooBig) box.append(el('p', 'note', "Its screenshot was too big to keep."));
    return box;
  };
  const filter = { app: '', profile: '', bad: false, q: '' };
  const pass = (r) => (!filter.app || app(r) === filter.app) && (!filter.profile || profile(r) === filter.profile) && (!filter.bad || !r.ok) && (!filter.q || (what(r) + ' ' + (r.site || '')).toLowerCase().includes(filter.q));
  const options = (select, values, all) => {
    const keep = select.value;
    const first = el('option', null, all);
    first.value = '';
    select.replaceChildren(first);
    for (const v of [...new Set(values)].sort()) { const o = el('option', null, v); o.value = v; select.append(o); }
    select.value = values.includes(keep) ? keep : '';
  };
  const groups = () => {
    const out = [];
    const open = new Map();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const key = app(r) + '\u0001' + profile(r);
      let g = open.get(key);
      if (!g || r.ts - g.last > data.gap) { g = { first: r, last: r.ts, rows: [] }; out.push(g); open.set(key, g); }
      g.rows.unshift(r);
      g.last = r.ts;
    }
    return out.sort((a, b) => b.last - a.last);
  };
  const toggled = new Map();
  const nothing = 'Nothing yet. When an AI app uses your Chrome, each step shows up here as it happens.';
  const render = () => {
    if (!full) {
      const ol = el('ol', 'steps');
      for (const r of rows.slice(0, data.strip)) ol.append(step(r, true));
      list.replaceChildren(rows.length ? ol : el('p', 'note', nothing));
      return;
    }
    options($('f-app'), rows.map(app), 'All AI apps');
    options($('f-profile'), rows.map(profile), 'All Chrome profiles');
    const out = [];
    for (const g of groups()) {
      const shown = g.rows.filter(pass);
      if (!shown.length) continue;
      const id = String(g.first.id);
      const d = el('details', 'group');
      d.open = toggled.has(id) ? toggled.get(id) : out.length === 0;
      d.addEventListener('toggle', () => toggled.set(id, d.open));
      const bad = g.rows.filter((r) => !r.ok).length;
      const sum = el('summary');
      sum.append(el('strong', null, app(g.first)), ' in ', el('strong', null, profile(g.first)), ' · ' + day(g.first.ts) + ', ' + clock(g.first.ts) + (clock(g.last) === clock(g.first.ts) ? '' : ' – ' + clock(g.last)) + ' · ' + g.rows.length + (g.rows.length === 1 ? ' step' : ' steps') + (bad ? ', ' + bad + " didn't work" : ''));
      const ol = el('ol', 'steps');
      for (const r of shown) ol.append(step(r, false));
      d.append(sum);
      if (g.rows.some((r) => r.details === 1)) {
        const last = g.rows.slice(0, data.scriptMax);
        const a = el('a', 'script', g.rows.length > last.length ? 'Download the last ' + last.length + ' steps as a script' : 'Download these steps as a script');
        a.href = '/app/activity/script?ids=' + last.map((r) => r.id).reverse().join(',');
        a.title = 'Replay them with chrome-bridge on your computer. Steps without details become comments.';
        d.append(el('p', 'note'));
        d.lastChild.append(a);
      }
      d.append(ol);
      out.push(d);
    }
    list.replaceChildren(...(out.length ? out : [el('p', 'note', rows.length ? 'No steps match these filters.' : nothing)]));
    $('activity-more').hidden = !more;
  };
  const add = (r) => { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } };
  if (full) {
    $('f-app').onchange = (e) => { filter.app = e.target.value; render(); };
    $('f-profile').onchange = (e) => { filter.profile = e.target.value; render(); };
    $('f-bad').onchange = (e) => { filter.bad = e.target.checked; render(); };
    $('f-q').oninput = (e) => { filter.q = e.target.value.trim().toLowerCase(); render(); };
    $('activity-more').onclick = async (e) => {
      const b = e.target;
      b.disabled = true;
      try {
        const res = await fetch('/app/activity.json?before=' + rows[rows.length - 1].id);
        if (!res.ok) throw new Error(String(res.status));
        const got = await res.json();
        got.rows.forEach(add);
        rows.sort((x, y) => y.id - x.id);
        more = got.more;
      } catch {
        b.textContent = "Couldn't load older steps. Reload the page (you may need to sign in again).";
      }
      b.disabled = false;
      render();
    };
  }
  // The page missed more than the live feed sends at once: start over from the newest.
  const reload = async () => {
    try {
      const res = await fetch('/app/activity.json');
      if (!res.ok) throw new Error(String(res.status));
      const got = await res.json();
      rows = got.rows;
      more = got.more;
      seen.clear();
      rows.forEach((r) => seen.add(r.id));
      render();
    } catch {
      live(false, "This page missed some steps. Reload it to see them (you may need to sign in again).");
    }
  };
  const live = (on, text) => { status.textContent = text; status.className = on ? 'note live' : 'note'; };
  let delay = 1000;
  let failures = 0;
  const connect = () => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/app/activity/live?after=' + (rows.length ? rows[0].id : 0));
    let ping = 0;
    ws.onopen = () => { delay = 1000; failures = 0; live(true, '● Live: new steps appear here as they happen'); ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 20000); };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.reset) return reload();
      (m.rows || []).forEach(add);
      rows.sort((x, y) => y.id - x.id);
      render();
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (e.code === 4401) return live(false, 'Your Cloud Bridge data was deleted, so this page stopped updating. Reload it to start again.');
      if (e.code === 4000) return live(false, (e.reason || 'This page stopped updating') + '. Reload it to see new steps.');
      failures++;
      live(false, failures > 3 ? "Can't reach Cloud Bridge right now. Reload the page (you may need to sign in again)." : 'Reconnecting…');
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  render();
  connect();
})();`;

let script: Promise<InlineScript> | null = null;
export function activityScript(): Promise<InlineScript> {
  return (script ??= inlineScript(CODE));
}

export const ACTIVITY_STYLE = `<style>.steps{list-style:none;padding:0;margin:.75rem 0}.step{display:flex;flex-wrap:wrap;gap:.4rem 1rem;align-items:baseline;padding:.8rem 0;margin:0;border-top:1px solid #ede9fe;font-size:.95rem}
.step .when,.step .ms{color:#666;font-variant-numeric:tabular-nums}.step .who{font-weight:600}.step .mark{margin-left:auto;color:#16a34a;font-weight:700}.step.bad .mark{color:#dc2626}.step .why{flex-basis:100%;color:#b91c1c;font-size:.88rem;margin-top:.1rem}
.filters{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:center;margin:1.75rem 0 1.25rem}.filters select{font:inherit;padding:.55rem .7rem;border:1px solid #c4b5fd;border-radius:.4rem;background:inherit;color:inherit}.filters label{font-size:.92rem}
.step .linkish{font:inherit;font-size:.85rem;padding:0;border:0;background:none;color:#6d28d9;cursor:pointer;text-decoration:underline}.step .gone{color:#666}
.step .more{flex-basis:100%;margin:.6rem 0 .2rem}.step .more pre{white-space:pre-wrap;word-break:break-word;background:#f3f0ff;padding:.8rem 1rem;border-radius:.5rem;margin:.4rem 0 1rem;font-size:.86rem;line-height:1.5;max-height:20rem;overflow:auto}.step .more .label{font-size:.82rem;color:#666;margin-top:.5rem}.step .more img{max-width:100%;border:1px solid #ddd6fe;border-radius:.5rem;margin-top:.5rem}
.live{color:#15803d}details.group{border-top:1px solid #ddd6fe;margin:0;padding:1rem 0}details.group>p.note{margin:.6rem 0 0}details.group summary{color:inherit}
@media(prefers-color-scheme:dark){.step .linkish{color:#c4b5fd}.step .more pre{background:#2a2340}.step .more .label,.step .gone{color:#aaa}.step{border-color:#3b2f5c}.step .when,.step .ms{color:#aaa}.step .why{color:#fca5a5}.live{color:#4ade80}details.group{border-color:#3b2f5c}}</style>`;

// The rows and what the script needs, as a data block (never executed, so the
// CSP's script hash doesn't cover it; "<" is escaped so no row can end it).
export function activityData(mode: 'full' | 'strip', rows: ActivityView[], more: boolean, apps: Record<string, string>): string {
  const body = JSON.stringify({ mode, rows, more, apps, gap: GROUP_GAP_MS, strip: STRIP_ROWS, scriptMax: SCRIPT_STEPS_MAX }).replace(/</g, '\\u003c');
  return `<script type="application/json" id="activity-data">${body}</script>`;
}

// GET /app/activity.json?before=<id>: older rows for "Show older steps".
export async function activityJson(request: Request, env: HubEnv): Promise<Response> {
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return json({ error: 'signed_out', message: 'Sign in again: reload the page.' }, 401);
  const before = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get('before')) || 0));
  return json(await hubOf(env, session.uid).activityRows(before, PAGE_ROWS));
}

// GET /app/activity/live (WebSocket): the account's own pages only. Browsers send
// the cookie with any site's WebSocket to here, so the Origin must be this hub's.
export async function activityLive(request: Request, env: HubEnv): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('This is the live feed of the Activity page: open /app/activity in a browser.', { status: 426 });
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return new Response("The live feed opens only from Cloud Bridge's own Activity page.", { status: 403 });
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return new Response('Signed out: open /app/activity and sign in again.', { status: 401 });
  const after = Math.max(0, Math.floor(Number(url.searchParams.get('after')) || 0));
  return hubOf(env, session.uid).fetch(new Request(new URL(`${LIVE_PATH}?after=${after}`, url.origin), { headers: { Upgrade: 'websocket' } }));
}

const stepId = (request: Request) => Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get('id')) || 0));

// GET /app/activity/details?id=<id>: a step's kept details, for "Details".
export async function activityDetails(request: Request, env: HubEnv): Promise<Response> {
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return json({ error: 'signed_out', message: 'Sign in again: reload the page.' }, 401);
  const details = await hubOf(env, session.uid).stepDetails(stepId(request));
  return details ? json(details) : json({ error: 'gone', message: "This step's details aren't kept any more." }, 404);
}

// GET /app/activity/image?id=<id>: a kept screenshot. Served as an image only
// (no sniffing, sandboxed): the bytes came from a browser page.
export async function activityImage(request: Request, env: HubEnv): Promise<Response> {
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return new Response('Signed out: reload the page.', { status: 401 });
  const image = await hubOf(env, session.uid).stepImage(stepId(request));
  if (!image) return new Response("This screenshot isn't kept any more.", { status: 404 });
  return new Response(image.bytes, { headers: { 'Content-Type': image.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}

// GET /app/activity/script?ids=1,2,3: those steps as a chrome-bridge batch script.
export async function activityScriptFile(request: Request, env: HubEnv): Promise<Response> {
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return Response.redirect(new URL('/login?next=/app/activity', request.url).href, 303);
  const asked = [...new Set((new URL(request.url).searchParams.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const ids = asked.slice(0, SCRIPT_STEPS_MAX);
  const { steps, kept, text } = await hubOf(env, session.uid).stepScript(ids);
  const head = [
    ...(asked.length > ids.length ? [`# Only the first ${ids.length} of the ${asked.length} steps asked for: a script holds at most ${SCRIPT_STEPS_MAX}.`] : []),
    '# Steps an AI app took in your Chrome, from Cloud Bridge Activity, oldest first.',
    `# ${steps} ${steps === 1 ? 'step' : 'steps'}, ${kept} with ${kept === 1 ? 'its command' : 'their commands'}; the rest are comments. Typed text shows as "***".`,
    '# Replay them with chrome-bridge on your computer: node cli.mjs batch < steps.txt',
  ];
  return new Response(`${head.join('\n')}\n${text}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="steps.txt"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
