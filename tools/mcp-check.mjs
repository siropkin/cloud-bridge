#!/usr/bin/env node
// Scripted MCP client: the MCP Inspector's checks without its UI. Runs the real
// OAuth 2.1 flow (dynamic registration, PKCE, loopback callback), then lists
// the hub's tools and optionally calls one.
//
//   node tools/mcp-check.mjs [--hub http://localhost:8787] [--call <tool> '<json args>'] [--open "<cmd>"]
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
const callIdx = args.indexOf('--call');
const CALL = callIdx >= 0 ? { name: args[callIdx + 1], arguments: JSON.parse(args[callIdx + 2] ?? '{}') } : null;

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
console.log('tools/list:', JSON.stringify(tools.map((t) => ({ name: t.name, args: Object.keys(t.inputSchema?.properties ?? {}) }))));
if (CALL) {
  const res = await client.callTool(CALL);
  console.log(`tools/call ${CALL.name}:`, JSON.stringify(res));
}
await client.close();
