// /app/settings: what AI apps may do in each Chrome profile (decision d3-design).
// Each command Allow, Ask or Off, from the list the profile itself sent (arm/hello
// registry), and the websites AI apps can't use there at all. Rules are kept per
// profile; the hub tells the profile at once, hides an Off command's tools from
// AI apps and refuses them (src/tools.ts). Ask is the profile's to enforce: it
// asks the person on their computer before each such step. Plain HTML form, no script.
import { requireSession, type HubEnv } from './auth';
import { back, csrfFor, formFor, hidden, hubOf } from './app';
import { BLOCKED_MAX, type ProfileSettings } from './hub';
import { armLabel } from './kinds';
import { escapeHtml, page } from './util';

// A website as the person typed it ("https://www.Chase.com/login", "*.chase.com")
// → the name blocked with its subdomains ("chase.com"), or null. A leading www.
// goes: blocking www.chase.com is meant to block chase.com.
export function siteOf(line: string): string | null {
  let s = line.trim().toLowerCase().replace(/^\*\./, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/\.+$/, '').replace(/^www\./, '');
  return host.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

// The textarea, one website per line: the names to keep (no repeats, at most
// BLOCKED_MAX) and how many lines were left out.
export function parseBlocked(text: string): { sites: string[]; skipped: number } {
  const sites: string[] = [];
  let skipped = 0;
  for (const line of text.slice(0, 64_000).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const site = siteOf(line);
    if (!site || (sites.length >= BLOCKED_MAX && !sites.includes(site))) skipped++;
    else if (!sites.includes(site)) sites.push(site);
  }
  return { sites, skipped };
}

const STYLE = `<style>.rule{display:flex;gap:1rem;align-items:center;justify-content:space-between;border-top:1px solid #ede9fe;padding:.75rem 0}.rule:first-of-type{border-top:0;padding-top:0}
.choice{display:flex;gap:1.25rem;flex:none}.choice label{display:flex;gap:.4rem;align-items:center;cursor:pointer}.choice input{flex:none;min-width:auto;padding:0;margin:0}
.word{color:#666;font-size:.85rem;margin-left:.5rem}textarea{font:inherit;width:100%;box-sizing:border-box;padding:.6rem .75rem;border:1px solid #c4b5fd;border-radius:.5rem;margin:.5rem 0}
.profiles{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;margin:1.5rem 0}
@media(prefers-color-scheme:dark){.rule{border-color:#3b2f5c}.word{color:#aaa}textarea{background:#16131f;color:#eee;border-color:#3b2f5c}}</style>`;

function skippedNote(n: number): string {
  return n === 1 ? "1 line wasn't a website address, so it was left out." : `${n} lines weren't website addresses (or went past ${BLOCKED_MAX} websites), so they were left out.`;
}

function rulesForm(p: ProfileSettings, csrf: string): string {
  if (!p.settable) {
    return `<p>This Chrome profile hasn't told Cloud Bridge what it can do, so there's nothing to set for it yet. chrome-bridge 1.35 or later does that each time it connects: update chrome-bridge, then reload this page.</p>`;
  }
  const groups = new Map<string, ProfileSettings['registry']>();
  for (const e of p.registry) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  const sections = [...groups].map(([group, entries]) => {
    const rows = entries.map((e) => {
      const rule = Object.hasOwn(p.rules.commands, e.name) ? p.rules.commands[e.name] : 'allow';
      const radio = (value: string, label: string) => `<label><input type="radio" name="c:${e.name}" value="${value}"${rule === value ? ' checked' : ''}> ${label}</label>`;
      return `<div class="rule"><span>${escapeHtml(e.title)}<span class="word">${e.name}</span></span><span class="choice" role="radiogroup" aria-label="${escapeHtml(e.title)}">${radio('allow', 'Allow')}${radio('ask', 'Ask')}${radio('off', 'Off')}</span></div>`;
    });
    return `<section><h2>${escapeHtml(group)}</h2>\n${rows.join('\n')}</section>`;
  });
  return `<form method="post" action="/app/settings">${hidden({ csrf, profile: p.id })}
${sections.join('\n')}
<section><h2>Websites AI apps can't use</h2>
<p>AI apps can't open, read or act on these websites in this Chrome profile, including their subdomains: blocking chase.com blocks www.chase.com and secure.chase.com too. Tabs on them still show up for AI apps, without their address or title.</p>
<label for="blocked">One website per line:</label>
<textarea id="blocked" name="blocked" rows="6" placeholder="chase.com&#10;mail.google.com">${escapeHtml(p.rules.blockedDomains.join('\n'))}</textarea></section>
<p><button>Save</button></p></form>`;
}

// GET /app/settings[?profile=<id>]
export async function settingsPage(request: Request, env: HubEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const [profiles, csrf] = await Promise.all([hubOf(env, session.uid).profileSettings(), csrfFor(session.uid, env.COOKIE_ENCRYPTION_KEY)]);
  const head = `${STYLE}<p class="note">Signed in with GitHub as <strong>@${escapeHtml(session.login)}</strong> · <a href="/app">Back to your Cloud Bridge</a></p>`;
  if (!profiles.length) {
    return page('What AI apps may do in your Chrome', `${head}
<p>No Chrome is connected yet. Click the chrome-bridge icon in your Chrome toolbar → ⚙ Settings → <b>Cloud AI apps</b> → Connect, then come back here.</p>`);
  }
  const chosen = profiles.find((p) => p.id === params.get('profile')) ?? profiles[0];
  const skipped = Number(params.get('skipped')) || 0;
  const flash =
    params.get('done') === 'saved'
      ? `<p class="ok">Saved. AI apps follow these rules from their next step in this Chrome profile.${skipped > 0 ? ` ${skippedNote(Math.floor(skipped))}` : ''}</p>\n`
      : params.get('error') === 'stale'
        ? '<p class="warn">This page was out of date, so nothing changed. Try again.</p>\n'
        : params.get('error') === 'gone'
          ? '<p class="warn">That Chrome profile was disconnected, so nothing changed.</p>\n'
          : '';
  const others = profiles.length > 1
    ? `<p class="profiles">${profiles.map((p) => (p.id === chosen.id ? `<strong>${escapeHtml(p.name)}</strong>` : `<a href="/app/settings?profile=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>`)).join('')}</p>\n`
    : '';
  return page(
    'What AI apps may do in your Chrome',
    `${head}
${flash}<p>Choose what AI apps may do in each Chrome profile. Everything is allowed until you change it here. <strong>Ask</strong> shows a small chrome-bridge window in that Chrome each time, with Allow once and Deny; no answer within 45 seconds counts as Deny. When something is off or you deny it, AI apps are told so and do the task without it.</p>
${others}<h2>${escapeHtml(armLabel(chosen.kind, chosen.name))}</h2>
${rulesForm(chosen, csrf)}`,
  );
}

// POST /app/settings {csrf, profile, c:<command>=allow|ask|off…, blocked}
export async function saveSettings(request: Request, env: HubEnv): Promise<Response> {
  const got = await formFor(request, env, '/app/settings');
  if (got instanceof Response) return got;
  const id = String(got.form.get('profile') ?? '');
  const commands: Record<string, string> = {};
  for (const [key, value] of got.form) if (key.startsWith('c:')) commands[key.slice(2)] = String(value);
  const { sites, skipped } = parseBlocked(String(got.form.get('blocked') ?? ''));
  const saved = await hubOf(env, got.session.uid).saveRules(id, commands, sites);
  if (saved !== 'ok') return back(request, 'error=gone', '/app/settings');
  return back(request, `profile=${encodeURIComponent(id)}&done=saved${skipped ? `&skipped=${skipped}` : ''}`, '/app/settings');
}
