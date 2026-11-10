import { env } from 'cloudflare:workers';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import type { Props } from './auth';
import pkg from '../package.json';
import docs from './chrome-docs.json';
import { isText, parseFileUrl } from './files';

// Descriptive, not orders: Claude read the earlier imperative wording ("tell the
// user exactly…") as a possible prompt injection and paused.
const INSTRUCTIONS = `Cloud Bridge connects this conversation to the user's own Chrome (through the chrome-bridge extension): their real tabs, signed in to their accounts.
The chrome_* tools each do one step (chrome_tabs, chrome_snap, chrome_click, chrome_fill, …); chrome and chrome_batch take any chrome-bridge command line. The reading tools (chrome_tabs, chrome_snap, chrome_shot, chrome_measure, chrome_wait, chrome_release) are marked read-only, so the user can allow them once instead of on every call.
When no Chrome is connected or online, the tool's answer says what the user can do about it, which is useful to pass on.
When the user has connected several Chrome profiles, the tools take a profile argument that names one.
The chrome-bridge manual is available as resources (SKILL.md first, then the command reference and recipes). Files a command saves (fetch --out, net --har) come back as a download link the user can open for an hour while signed in to Cloud Bridge; resources/read on that link returns the file here.`;

type Doc = { uri: string; name: string; title: string; description: string; mimeType: string; text: string };
const DOCS = docs as Doc[];

// resources/read: the manual, or a file this user's arm saved (owner only: the KV key carries the user id).
async function readResource(uri: string, userId: string) {
  const doc = DOCS.find((d) => d.uri === uri);
  if (doc) return { contents: [{ uri, mimeType: doc.mimeType, text: doc.text }] };
  const id = parseFileUrl(uri, new URL(env.MCP_RESOURCE).origin);
  const file = id ? await hubFor(userId).readFile(userId, id) : null;
  if (!file) throw new Error(id ? 'This file link expired (links last an hour): run the command again for a new one.' : `Unknown resource ${uri}: resources/list shows the manual; file links come from fetch --out and net --har.`);
  const { bytes, meta } = file;
  if (isText(meta.mimeType)) return { contents: [{ uri, mimeType: meta.mimeType, text: new TextDecoder().decode(bytes) }] };
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { contents: [{ uri, mimeType: meta.mimeType, blob: btoa(bin) }] };
}

function hubFor(userId: string) {
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId));
}

// Stateless: one Server per request, its tools read from the user's hub at call time.
export const mcpHandler = createMcpHandler(
  () => {
    const props = getMcpAuthContext()?.props as Props | undefined;
    if (!props?.userId) throw new Error('MCP request without an authenticated user');
    const hub = hubFor(props.userId);
    const server = new Server({ name: 'cloud-bridge', version: pkg.version }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler('tools/list', async () => ({ tools: await hub.listTools() }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: args = {} } = request.params;
      // Arms send MCP content blocks; the hub passes them through without reshaping.
      return (await hub.callTool(name, args, { client: ctx.http?.authInfo?.clientId })) as CallToolResult;
    });
    server.setRequestHandler('resources/list', async () => ({ resources: DOCS.map(({ text, ...d }) => ({ ...d, size: new TextEncoder().encode(text).length })) }));
    server.setRequestHandler('resources/read', async (request) => readResource(request.params.uri, props.userId));
    return server;
  },
  { route: '/mcp' },
);
