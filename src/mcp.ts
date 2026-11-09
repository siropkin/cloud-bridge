import { env } from 'cloudflare:workers';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import type { Props } from './auth';
import pkg from '../package.json';

const INSTRUCTIONS = `Cloud Bridge connects you to the user's own machines ("arms"), for example their real, logged-in Chrome.
Tools are named after the arm kind (chrome_…). When a tool answers that no arm is online, tell the user exactly what it says to do, then retry.
When several arms of a kind are online, pass the selector argument the tool describes (chrome: profile).`;

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
