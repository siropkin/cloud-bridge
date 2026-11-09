import { CHROME_STORE } from './kinds';
import { escapeHtml, page } from './util';

// Pages for people, not developers: plain words, one obvious next action each.
// Re-check the apps' menus when they change (both changed within weeks in 2026).
const APPS = {
  claude: {
    name: 'Claude',
    url: 'https://claude.ai/customize/connectors',
    steps: [
      'Click <b>Add connector</b> → <b>Add custom connector</b>.',
      'Name it <b>Cloud Bridge</b>, paste the link, click <b>Add</b>, then <b>Connect</b>.',
      'On the Cloud Bridge page that opens, click <b>Allow</b>.',
    ],
    after: 'Claude asks before it acts in your Chrome. Reading (listing tabs, reading a page, screenshots) can be allowed once for good; for other actions you trust, choose <b>Always allow</b>.',
  },
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/plugins',
    steps: [
      'Click <b>Add</b> → <b>Add custom MCP server</b>.',
      'Name it <b>Cloud Bridge</b>, paste the link as the Server URL, choose <b>OAuth</b>, tick <b>I understand</b>, then <b>Create as a plugin</b> → <b>Connect</b>.',
      'On the Cloud Bridge page that opens, click <b>Allow</b>.',
    ],
    after: 'In a chat, ask ChatGPT to use Cloud Bridge.',
  },
} as const;

export type App = keyof typeof APPS;

const COPY_CODE = `for (const b of document.querySelectorAll('button[data-copy]')) b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied ✓'; }, () => { b.textContent = 'Select the link and copy it'; }));`;
// CSP hash of COPY_CODE: test/guide.spec.ts recomputes it, so an edit to the code fails until this is updated.
export const COPY_SCRIPT = { code: COPY_CODE, hash: 'yDXG+efyDh5T82T37yo2px34g3qLgIEl5uh5TZeV61w=' };

function connectorUrl(requestUrl: string): string {
  return new URL('/mcp', requestUrl).href;
}

// The connector link with a Copy button, then each app's steps (the chosen app first).
export function addSteps(requestUrl: string, first: App = 'claude'): string {
  const link = escapeHtml(connectorUrl(requestUrl));
  const order: App[] = first === 'chatgpt' ? ['chatgpt', 'claude'] : ['claude', 'chatgpt'];
  const apps = order.map((id) => {
    const a = APPS[id];
    return `<section><h2>${a.name}</h2>
<p><a class="button" href="${a.url}" target="_blank" rel="noopener">Open ${a.name}</a></p>
<ol>${a.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
<p class="note">${a.after}</p></section>`;
  });
  return `<p>Your Cloud Bridge link:</p>
<p class="link"><code>${link}</code> <button data-copy="${link}">Copy</button></p>
${apps.join('\n')}`;
}

export function homePage(request: Request): Response {
  return page(
    'Cloud Bridge',
    `<p>Lets Claude, ChatGPT and other AI apps use your own Chrome, with your tabs and the accounts you're signed in to. You stay in control: switch it off any time in the extension.</p>
<ol>
<li><b>Install chrome-bridge</b> from the <a href="${CHROME_STORE}" target="_blank" rel="noopener">Chrome Web Store</a>.</li>
<li><b>Connect your Chrome</b>: click the chrome-bridge icon in your toolbar → ⚙ Settings → <b>Cloud AI apps</b> → Connect. Sign in with GitHub and confirm.</li>
<li><b>Add Cloud Bridge to your AI app</b>:</li>
</ol>
${addSteps(request.url)}
<p class="note">Open source: <a href="https://github.com/siropkin/cloud-bridge">github.com/siropkin/cloud-bridge</a>.</p>`,
    { script: COPY_SCRIPT },
  );
}

// /add?app=claude|chatgpt — the chrome-bridge popup's "Add to Claude" / "Add to ChatGPT".
export function addPage(request: Request): Response {
  const app: App = new URL(request.url).searchParams.get('app') === 'chatgpt' ? 'chatgpt' : 'claude';
  return page(`Add Cloud Bridge to ${APPS[app].name}`, addSteps(request.url, app), { script: COPY_SCRIPT });
}
