#!/usr/bin/env node
// A fake arm for developing the hub without Chrome: pairs once, then serves two
// tools (echo, fake_snap) over the same protocol the chrome-bridge extension speaks.
//
//   node tools/fake-arm.mjs [--hub http://localhost:8787] [--name birch] [--once]
//   node tools/fake-arm.mjs --name birch --revoke   (sign this arm out: the hub forgets it)
//
// The first run prints a pairing link; approve it in a browser. The arm token is
// saved to ~/.cloud-bridge/fake-arm-<name>.json (delete it to pair again).
// Zero dependencies: Node 22+ has fetch and WebSocket built in.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const HUB = opt('hub', process.env.CLOUD_BRIDGE_HUB ?? 'http://localhost:8787').replace(/\/$/, '');
const NAME = opt('name', 'birch');
const ONCE = args.includes('--once'); // exit after the first close (tests)
const FILE = join(homedir(), '.cloud-bridge', `fake-arm-${NAME.replace(/[^\w-]/g, '_')}.json`);
const log = (...a) => console.log(`[fake-arm ${NAME}]`, ...a);

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text back. Use it to test that Cloud Bridge reaches this arm.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fake_snap',
    description: 'Return a fake accessibility snapshot of a page, shaped like chrome-bridge snap output.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Page URL to pretend to snapshot' } } },
    annotations: { readOnlyHint: true },
  },
];

function call(name, a = {}) {
  if (name === 'echo') {
    if (typeof a.text !== 'string') return { content: [{ type: 'text', text: 'echo needs {"text": "<string>"}.' }], isError: true };
    return { content: [{ type: 'text', text: a.text }] };
  }
  if (name === 'fake_snap') {
    const url = a.url ?? 'https://example.com/';
    return { content: [{ type: 'text', text: `${url}  "Example Domain"\n[1] heading "Example Domain"\n[2] link "More information..."` }] };
  }
  return { content: [{ type: 'text', text: `Unknown tool ${name}. Tools: ${TOOLS.map((t) => t.name).join(', ')}.` }], isError: true };
}

async function post(path, body) {
  const res = await fetch(HUB + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function pair() {
  const start = await post('/pair/start', { kind: 'fake', name: NAME });
  if (start.status !== 200) throw new Error(`pair/start: ${start.status} ${JSON.stringify(start.body)}`);
  const { code, pollToken, verificationUri, interval, expiresIn } = start.body;
  log(`pair code ${code}: open ${verificationUri} and click Connect (expires in ${Math.round(expiresIn / 60)} min)`);
  const until = Date.now() + expiresIn * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const poll = await post('/pair/poll', { code, pollToken });
    if (poll.body.status === 'approved') {
      await mkdir(join(homedir(), '.cloud-bridge'), { recursive: true });
      await writeFile(FILE, JSON.stringify({ hub: HUB, armToken: poll.body.armToken, armUrl: poll.body.armUrl }), { mode: 0o600 });
      log('paired');
      return poll.body;
    }
    if (poll.body.status !== 'pending') throw new Error(`pairing ${poll.body.status}: ${poll.body.message}`);
  }
  throw new Error('pairing code expired; run again');
}

async function credentials() {
  try {
    const saved = JSON.parse(await readFile(FILE, 'utf8'));
    if (saved.hub === HUB) return saved;
  } catch {
    // not paired yet
  }
  return pair();
}

// Signs out the way the extension does when Cloud AI apps is switched off.
async function revoke() {
  let saved;
  try {
    saved = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return log(`not paired (no ${FILE}): nothing to revoke`);
  }
  const res = await fetch(saved.hub + '/arm/revoke', { method: 'POST', headers: { Authorization: `Bearer ${saved.armToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`revoke: ${res.status} ${body.message ?? ''}`);
  await rm(FILE, { force: true });
  log(body.revoked ? `signed out of ${saved.hub}` : `${saved.hub} had already forgotten this arm`);
}

async function run() {
  if (args.includes('--revoke')) return revoke();
  const { armToken, armUrl } = await credentials();
  let backoff = 1000;
  for (;;) {
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(armUrl, ['cloud-bridge.v1', `cbtoken.${armToken}`]);
      let ping;
      ws.onopen = () => {
        backoff = 1000;
        log('connected');
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/hello', params: { kind: 'fake', name: NAME, version: '0.1.0', selector: 'arm', offlineHint: `Ask the user to run \`npm run fake-arm -- --name ${NAME}\` in the cloud-bridge repo` } }));
        ping = setInterval(() => ws.send('ping'), 20_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        const msg = JSON.parse(ev.data);
        if (msg.method === 'arm/policy') return log('policy', JSON.stringify(msg.params));
        if (msg.method === 'arm/name') return log('AI apps call this arm', JSON.stringify(msg.params?.name));
        if (msg.method === 'tools/list') return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }));
        if (msg.method === 'tools/call') {
          log('call', msg.params.name, JSON.stringify(msg.params.arguments));
          return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: call(msg.params.name, msg.params.arguments) }));
        }
        if (msg.id !== undefined && msg.method) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }));
      };
      ws.onclose = (ev) => {
        clearInterval(ping);
        resolve(ev.code);
      };
      ws.onerror = () => {}; // onclose follows
    });
    if (code === 4401) {
      await rm(FILE, { force: true });
      return log('the hub no longer knows this arm (revoked?); run again to pair');
    }
    log(code === 1006 ? 'connection lost (1006): is the hub running? retrying' : `connection closed (${code})`);
    if (ONCE) return;
    if (code === 4000) return log('another connection of this arm took over; exiting');
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

run().catch((error) => {
  console.error(`[fake-arm ${NAME}] ${error.message}`);
  process.exit(1);
});
