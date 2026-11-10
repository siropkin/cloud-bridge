#!/usr/bin/env node
// Scripted MCP client: the MCP Inspector's checks without its UI. Runs the real
// OAuth 2.1 flow (dynamic registration, PKCE, loopback callback), then lists
// the hub's tools and resources, and optionally calls tools and reads resources.
//
//   node tools/mcp-check.mjs [--hub http://localhost:8787] [--call <tool> '<json args>']... [--read <uri|link>]... [--open "<cmd>"]
//
// --call and --read repeat: they run in order over one session (one sign-in).
// --read link reads the file link the previous --call returned (fetch --out, net --har).
//
// It prints the authorization URL; open it in the browser that is signed in to
// the hub (--open runs a command with the URL appended, e.g. chrome-bridge's
// `node cli.mjs open --profile poplar`). Tokens are kept in memory only.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const HUB = (opt('hub') ?? 'http://localhost:8787').replace(/\/$/, '');
const PORT = 8790;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const STEPS = args.flatMap((a, i) => (a === '--call' ? [{ name: args[i + 1], arguments: JSON.parse(args[i + 2] ?? '{}') }] : a === '--read' ? [{ read: args[i + 1] }] : []));

const store = {};
const provider = {
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata() {
    return { client_name: 'cloud-bridge mcp-check', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  },
  clientInformation: () => store.client,
  saveClientInformation: (c) => void (store.client = c),
  tokens: () => store.tokens,
  saveTokens: (t) => void (store.tokens = t),
  saveCodeVerifier: (v) => void (store.verifier = v),
  codeVerifier: () => store.verifier,
  saveDiscoveryState: (d) => void (store.discovery = d),
  discoveryState: () => store.discovery,
  redirectToAuthorization: (url) => {
    console.log(`authorize: ${url.href}`);
    const open = opt('open');
    if (open) {
      const [cmd, ...rest] = open.split(' ');
      execFile(cmd, [...rest, url.href], (err, out) => err && console.error(`--open failed: ${err.message} ${out}`));
    }
  },
};

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('mcp-check got the authorization. You can close this tab.');
      server.close();
      u.searchParams.get('code') ? resolve(u.searchParams) : reject(new Error(`authorization failed: ${u.searchParams.get('error')}`));
    });
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => reject(new Error('no authorization within 5 min')), 300_000).unref();
  });
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), { authProvider: provider });
  const client = new Client({ name: 'cloud-bridge mcp-check', version: '0.1.0' });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    const params = await waitForCode();
    await transport.finishAuth(params);
    const again = new Client({ name: 'cloud-bridge mcp-check', version: '0.1.0' });
    await again.connect(new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), { authProvider: provider }));
    return again;
  }
}

const client = await connect();
console.log('connected; server instructions:', JSON.stringify(client.getInstructions?.() ?? null));
const { tools } = await client.listTools();
// What the Inspector shows: name, title, arguments (* = required) and the annotation hints AI apps act on.
console.log(`tools/list: ${tools.length} tools`);
for (const t of tools) {
  const req = new Set(t.inputSchema?.required ?? []);
  const hints = Object.entries(t.annotations ?? {}).filter(([k, v]) => k.endsWith('Hint') && v).map(([k]) => k.replace('Hint', ''));
  console.log(`  ${t.name} — ${t.title ?? ''} (${Object.keys(t.inputSchema?.properties ?? {}).map((k) => k + (req.has(k) ? '*' : '')).join(', ')}) [${hints.join(', ') || 'no hints'}]`);
}
const { resources } = await client.listResources();
console.log(`resources/list: ${resources.length} resources`);
for (const r of resources) console.log(`  ${r.uri} — ${r.title ?? r.name} (${r.mimeType}, ${r.size ?? '?'} bytes)`);
let lastLink;
for (const step of STEPS) {
  if (step.read) {
    const uri = step.read === 'link' ? lastLink : step.read;
    if (!uri) throw new Error('--read link: the previous --call returned no resource_link');
    const { contents } = await client.readResource({ uri });
    console.log(`resources/read ${uri}:`, JSON.stringify(contents.map((c) => ({ uri: c.uri, mimeType: c.mimeType, ...(c.text !== undefined ? { chars: c.text.length, head: c.text.slice(0, 120) } : { blobBytes: Math.round((c.blob?.length ?? 0) * 0.75) }) }))));
    continue;
  }
  const res = await client.callTool(step);
  lastLink = res.content?.findLast?.((c) => c.type === 'resource_link')?.uri ?? lastLink;
  const shown = { ...res, content: res.content?.map((c) => (c.type === 'image' ? { type: 'image', mimeType: c.mimeType, bytes: Math.round((c.data?.length ?? 0) * 0.75) } : c)) };
  console.log(`tools/call ${step.name}:`, JSON.stringify(shown));
}
await client.close();
