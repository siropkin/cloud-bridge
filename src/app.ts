// /app: the signed-in person's own page. What's connected (Chrome profiles, AI
// apps), how to add one, and the account itself (sign out, delete my data).
// Plain HTML forms (scripts: the copy button, the live activity list): every
// action is a POST with a token bound to this account, from the hub's own pages only.
import type { GrantSummary } from '@cloudflare/workers-oauth-provider';
import { clearSession, readSession, requireSession, sameOrigin, type HubEnv, type Session } from './auth';
import { ACTIVITY_STYLE, activityData, activityScript, PAGE_ROWS, STRIP_ROWS } from './activity';
import { addSteps, COPY_SCRIPT } from './guide';
import { DETAILS_CAP, IMAGE_MAX, validArm, type ArmDetails } from './hub';
import { armLabel } from './kinds';
import { ago } from './tools';
import { escapeHtml, page, sign, verify } from './util';

const hubOf = (env: Env, uid: string) => env.USER_HUB.get(env.USER_HUB.idFromName(uid));
const csrfFor = (uid: string, secret: string) => sign(`app|${uid}`, secret);
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Fixed messages only: nothing from the query string reaches the page.
const DONE: Record<string, string> = {
  renamed: 'Renamed. AI apps use the new name from their next call.',
  disconnected: "Disconnected. AI apps can't use that Chrome profile until you connect it again from the chrome-bridge popup.",
  removed: "Removed. That AI app can't use your Chrome until you allow it again.",
  keeping: 'Cloud Bridge keeps details of new steps for 24 hours from now on.',
  cleared: "Cloud Bridge stopped keeping details and deleted the ones it had.",
};
const PROBLEM: Record<string, string> = {
  taken: 'Another Chrome profile already has that name, so nothing changed. Pick a different name.',
  invalid: 'A name needs 1 to 64 characters, so nothing changed.',
  gone: 'That was already removed.',
  stale: 'This page was out of date, so nothing changed. Try again.',
};

function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
}

interface AllowedApp {
  id: string;
  clientId: string;
  name: string;
  host: string;
  since: number; // ms
}

async function allowedApps(env: HubEnv, uid: string): Promise<AllowedApp[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(uid, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const apps = await Promise.all(
    grants.map(async (g) => {
      const client = await env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
      let host = '';
      try {
        host = g.redirectUri ? new URL(g.redirectUri).hostname : '';
      } catch {
        // an unusual redirect: show the app without it
      }
      return { id: g.id, clientId: g.clientId, name: client?.clientName?.trim() || g.clientId, host, since: g.createdAt * 1000 };
    }),
  );
  return apps.sort((a, b) => b.since - a.since);
}

// Activity names an app by the name it had when allowed, else by its grant's.
const appNames = (apps: AllowedApp[]) => Object.fromEntries(apps.map((a) => [a.clientId, a.name]));

function browsersSection(arms: ArmDetails[], csrf: string, now: number): string {
  if (!arms.length) {
    return `<section><h2>Your Chrome profiles</h2>
<p>No Chrome is connected yet. Click the chrome-bridge icon in your Chrome toolbar → ⚙ Settings → <b>Cloud AI apps</b> → Connect.</p></section>`;
  }
  const rows = arms.map((a) => {
    const status = a.online ? 'Online now' : `Offline, ${ago(a.lastSeen, now)}`;
    const facts = [status, a.version ? `version ${escapeHtml(a.version)}` : '', `connected ${day(a.createdAt)}`].filter(Boolean).join(' · ');
    return `<div class="item"><p><span class="dot ${a.online ? 'on' : 'off'}"></span><strong>${escapeHtml(armLabel(a.kind, a.name))}</strong><br><span class="note">${facts}</span></p>
<form method="post" action="/app/rename" class="row">${hidden({ csrf, id: a.id })}<input name="name" value="${escapeHtml(a.name)}" maxlength="64" required aria-label="New name for ${escapeHtml(a.name)}"> <button class="secondary">Rename</button></form>
<form method="post" action="/app/disconnect" class="row">${hidden({ csrf, id: a.id })}<button class="secondary">Disconnect</button></form></div>`;
  });
  return `<section><h2>Your Chrome profiles</h2>
${rows.join('\n')}
<p class="note">AI apps pick a profile by its name here. Disconnect signs it out right away; to use it again, turn on Cloud AI apps in the chrome-bridge popup.</p></section>`;
}

function appsSection(apps: AllowedApp[], csrf: string): string {
  if (!apps.length) return '<section><h2>AI apps you allowed</h2><p>None yet. Add Cloud Bridge to one below.</p></section>';
  const rows = apps.map(
    (a) => `<div class="item"><p><strong>${escapeHtml(a.name)}</strong><br><span class="note">${a.host ? `Access goes to ${escapeHtml(a.host)} · ` : ''}allowed ${day(a.since)}</span></p>
<form method="post" action="/app/forget" class="row">${hidden({ csrf, grant: a.id })}<button class="secondary">Remove</button></form></div>`,
  );
  return `<section><h2>AI apps you allowed</h2>
${rows.join('\n')}
<p class="note">Removing an app signs it out right away. It asks you again the next time it connects.</p></section>`;
}

// GET /app
export async function appPage(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const now = Date.now();
  const hub = hubOf(env, session.uid);
  const [arms, apps, csrf, latest, live] = await Promise.all([hub.armDetails(), allowedApps(env, session.uid), csrfFor(session.uid, env.COOKIE_ENCRYPTION_KEY), hub.activityRows(0, STRIP_ROWS), activityScript()]);
  const done = DONE[params.get('done') ?? ''];
  const problem = PROBLEM[params.get('error') ?? ''];
  const flash = done ? `<p class="ok">${done}</p>\n` : problem ? `<p class="warn">${problem}</p>\n` : '';
  return page(
    'Your Cloud Bridge',
    `<p class="note">Signed in with GitHub as <strong>@${escapeHtml(session.login)}</strong>.</p>
${flash}${ACTIVITY_STYLE}<section><h2>Latest from AI apps</h2>
<p id="activity-status" class="note">Connecting…</p>
<div id="activity-list"></div>
<p><a href="/app/activity">See everything AI apps did in your Chrome →</a></p>
${activityData('strip', latest.rows, latest.more, appNames(apps))}</section>
${browsersSection(arms, csrf, now)}
${appsSection(apps, csrf)}
<h2>Add Cloud Bridge to an AI app</h2>
${addSteps(request.url)}
<section><h2>Your account</h2>
<form method="post" action="/logout"><p><button class="secondary">Sign out</button></p></form>
<p><a href="/app/delete">Delete my data…</a> Signs out every Chrome profile and AI app and deletes what Cloud Bridge keeps for you.</p></section>`,
    { script: [COPY_SCRIPT, live], connect: new URL(request.url).origin },
  );
}

function detailsSection(keeping: boolean, csrf: string): string {
  const mb = DETAILS_CAP / 1048576;
  return keeping
    ? `<section><h2>Details</h2><p><strong>Cloud Bridge keeps each new step's details for 24 hours:</strong> the command, what it answered and its screenshot (up to ${IMAGE_MAX / 1024} KB). Typed text stays hidden as ***. Click <b>Details</b> on a step to see them, or download a group of steps as a script to replay with chrome-bridge. Up to ${mb} MB in all: past that, the oldest details go first.</p>
<form method="post" action="/app/activity/keep">${hidden({ csrf, on: '0' })}<p><button class="secondary">Stop keeping details</button> <span class="note">Deletes the details kept so far.</span></p></form></section>`
    : `<section><h2>Details</h2><p>To see exactly what each step did, Cloud Bridge can keep its command, what it answered and its screenshot for 24 hours. Typed text stays hidden as ***.</p>
<form method="post" action="/app/activity/keep">${hidden({ csrf, on: '1' })}<p><button class="secondary">Keep details for 24 hours</button></p></form></section>`;
}

// GET /app/activity: everything kept, grouped by app and profile, with filters; live.
export async function activityPage(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const hub = hubOf(env, session.uid);
  const [apps, { rows, more }, live, keeping, csrf] = await Promise.all([allowedApps(env, session.uid), hub.activityRows(0, PAGE_ROWS), activityScript(), hub.keepingDetails(), csrfFor(session.uid, env.COOKIE_ENCRYPTION_KEY)]);
  const params = new URL(request.url).searchParams;
  const done = DONE[params.get('done') ?? ''];
  const problem = PROBLEM[params.get('error') ?? ''];
  const flash = done ? `<p class="ok">${done}</p>\n` : problem ? `<p class="warn">${problem}</p>\n` : '';
  return page(
    'What AI apps did in your Chrome',
    `${ACTIVITY_STYLE}<p class="note">Signed in with GitHub as <strong>@${escapeHtml(session.login)}</strong> · <a href="/app">Back to your Cloud Bridge</a></p>
${flash}<p>Each step an AI app takes in your Chrome shows up here as it happens. Cloud Bridge keeps when it happened, which app and Chrome profile, what kind of step, the website and whether it worked. Steps stay for 30 days (the latest 5,000).</p>
${detailsSection(keeping, csrf)}
<div class="filters"><select id="f-app" aria-label="AI app"></select><select id="f-profile" aria-label="Chrome profile"></select>
<label><input type="checkbox" id="f-bad"> Only steps that didn't work</label><input id="f-q" type="search" placeholder="Search steps or websites" aria-label="Search steps or websites"></div>
<p id="activity-status" class="note">Connecting…</p>
<div id="activity-list"></div>
<p><button class="secondary" id="activity-more" hidden>Show older steps</button></p>
<noscript><p class="warn">This page needs JavaScript to show your activity.</p></noscript>
${activityData('full', rows, more, appNames(apps))}`,
    { script: live, connect: new URL(request.url).origin },
  );
}

const back = (request: Request, query: string, path = '/app') => Response.redirect(new URL(`${path}?${query}`, request.url).href, 303);

// The checks every POST here shares: signed in, from this hub's own page, with this
// account's token. Signed out: sign in, then the account page (not this POST's path).
async function formFor(request: Request, env: HubEnv, path = '/app'): Promise<{ session: Session; form: FormData } | Response> {
  const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY);
  if (!session) return Response.redirect(new URL(`/login?next=${path}`, request.url).href, 303);
  const form = await request.formData();
  if (!sameOrigin(request) || !(await verify(`app|${session.uid}`, String(form.get('csrf') ?? ''), env.COOKIE_ENCRYPTION_KEY))) return back(request, 'error=stale', path);
  return { session, form };
}

// POST /app/rename {id, name}
export async function renameBrowser(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env);
  if (got instanceof Response) return got;
  const name = String(got.form.get('name') ?? '').trim();
  if (/[\x00-\x1f\x7f]/.test(name) || validArm('chrome', name)) return back(request, 'error=invalid');
  const result = await hubOf(env, got.session.uid).renameArm(String(got.form.get('id') ?? ''), name);
  return back(request, result === 'ok' ? 'done=renamed' : `error=${result}`);
}

// POST /app/activity/keep {on: '1' | '0'}: off deletes what was kept.
export async function keepDetails(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env, '/app/activity');
  if (got instanceof Response) return got;
  const on = got.form.get('on') === '1';
  await hubOf(env, got.session.uid).setKeepDetails(on);
  return back(request, on ? 'done=keeping' : 'done=cleared', '/app/activity');
}

// POST /app/disconnect {id}
export async function disconnectBrowser(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env);
  if (got instanceof Response) return got;
  const dropped = await hubOf(env, got.session.uid).disconnectArm(String(got.form.get('id') ?? ''));
  return back(request, dropped ? 'done=disconnected' : 'error=gone');
}

// POST /app/forget {grant}: the grant and every token of it go, so the app's
// next call is refused at once (the library checks the token record).
export async function forgetApp(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env);
  if (got instanceof Response) return got;
  const grant = String(got.form.get('grant') ?? '');
  const uid = got.session.uid;
  if (!GRANT_ID.test(grant) || !(await allowedApps(env, uid)).some((a) => a.id === grant)) return back(request, 'error=gone');
  await env.OAUTH_PROVIDER.revokeGrant(grant, uid);
  return back(request, 'done=removed');
}

// GET /app/delete: the confirmation, so a stray click on the account page deletes nothing.
export async function deletePage(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const csrf = await csrfFor(session.uid, env.COOKIE_ENCRYPTION_KEY);
  return page(
    'Delete your Cloud Bridge data?',
    `<p>This signs out every Chrome profile and AI app connected to <strong>@${escapeHtml(session.login)}</strong>, and deletes what Cloud Bridge keeps for you: the connected profiles, the list of what AI apps did, saved files and the apps you allowed.</p>
<p>It can't be undone. You can start again any time by connecting a Chrome profile again. The chrome-bridge extension and everything on your computer stay as they are.</p>
<form method="post" action="/app/delete">${hidden({ csrf })}<p><button class="danger">Delete everything</button> <a class="button" href="/app">Cancel</a></p></form>`,
  );
}

// POST /app/delete: AI apps lose access first (no new calls), then the profiles,
// activity and files, then the sign-in cookie. A failure part way leaves the
// rest for a retry: every step is safe to run again.
export async function deleteAccount(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env);
  if (got instanceof Response) return got;
  const uid = got.session.uid;
  const apps = await allowedApps(env, uid);
  for (const a of apps) await env.OAUTH_PROVIDER.revokeGrant(a.id, uid);
  const { arms, files } = await hubOf(env, uid).deleteEverything(uid);
  const headers = new Headers();
  headers.append('Set-Cookie', clearSession(request.url));
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return page(
    'Your Cloud Bridge data is deleted',
    `<p>Cloud Bridge signed out ${count(arms, 'Chrome profile', 'Chrome profiles')} and ${count(apps.length, 'AI app', 'AI apps')}, and deleted what it kept for <strong>@${escapeHtml(got.session.login)}</strong>. You're signed out here too.</p>
${files === null ? "<p class=\"note\">Saved files couldn't be listed just now; they delete themselves within the hour.</p>\n" : ''}<p class="note">GitHub still lists Cloud Bridge among the apps you signed in to. To remove it there too: <a href="https://github.com/settings/applications" target="_blank" rel="noopener">GitHub → Settings → Applications</a> → Authorized OAuth Apps → Cloud Bridge → Revoke.</p>
<p><a href="/">Back to Cloud Bridge</a></p>`,
    { headers, icon: '✅' },
  );
}
