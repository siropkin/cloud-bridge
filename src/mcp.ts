import { env } from 'cloudflare:workers';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import type { Props } from './auth';
import pkg from '../package.json';

// Descriptive, not orders: Claude read the earlier imperative wording ("tell the
// user exactly…") as a possible prompt injection and paused.
const INSTRUCTIONS = `Cloud Bridge connects this conversation to the user's own Chrome (through the chrome-bridge extension): their real tabs, signed in to their accounts.
The chrome and chrome_batch tools take chrome-bridge command lines. When no Chrome is connected or online, the tool's answer says what the user can do about it, which is useful to pass on.
When the user has connected several Chrome profiles, the tools take a profile argument that names one.`;

function hubFor(userId: string) {
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId));
}

// Stateless: one Server per request, its tools read from the user's hub at call time.
export const mcpHandler = createMcpHandler(
  () => {
    const props = getMcpAuthContext()?.props as Props | undefined;
    if (!props?.userId) throw new Error('MCP request without an authenticated user');
    const hub = hubFor(props.userId);
    const server = new Server({ name: 'cloud-bridge', version: pkg.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler('tools/list', async () => ({ tools: await hub.listTools() }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: args = {} } = request.params;
      // Arms send MCP content blocks; the hub passes them through without reshaping.
      return (await hub.callTool(name, args, { client: ctx.http?.authInfo?.clientId })) as CallToolResult;
    });
    return server;
  },
  { route: '/mcp' },
);
