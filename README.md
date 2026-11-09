# Cloud Bridge

A free Cloudflare hub that lets cloud AIs (Claude.ai, ChatGPT, any remote-MCP client) use **arms** on your own machines. The first arm is your real, logged-in Chrome through the [chrome-bridge](https://github.com/siropkin/chrome-bridge) extension; local chrome-bridge keeps working beside it.

```
 AI clients ──MCP + OAuth──▶  Cloud Bridge (one Worker, one Durable Object per user)  ◀──WebSocket── arms
```

Status: B1, the hub skeleton. It runs locally with a fake arm; it isn't deployed yet and Chrome doesn't speak the protocol yet.

## How it works

- **Sign-in**: GitHub. AI clients get OAuth 2.1 + PKCE from [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (dynamic registration and CIMD); a consent page names the client and where access is sent.
- **`/mcp`**: stateless Streamable HTTP (MCP SDK v2 through `agents`' `createMcpHandler`). `tools/list` merges the tools of your paired arms, prefixed with the arm kind (`echo` on a `fake` arm → `fake_echo`). With several arms of a kind, tools gain a selector argument (`arm`; chrome uses `profile`).
- **Arms** pair with a device code and then hold one outbound WebSocket to `/arm`:
  1. `POST /pair/start {"kind","name"}` → `{code, pollToken, verificationUri}`.
  2. You open `verificationUri`, sign in and click Connect.
  3. `POST /pair/poll {code, pollToken}` → `{armToken, armUrl}` (once).
  4. Connect to `armUrl` with subprotocols `cloud-bridge.v1` and `cbtoken.<armToken>`. A bad or revoked token is closed with code `4401`.
- **Arm protocol** (JSON-RPC 2.0 text frames): the arm sends `arm/hello {kind, name, version, selector?, offlineHint?}`; the hub answers `arm/policy`, then asks `tools/list`; MCP calls become `tools/call {name, arguments, _meta}`. Heartbeat: the text frame `ping`, answered `pong` without waking the Durable Object.
- **Errors are written for the model** and name the next step: no arm online, which arm to pick, an arm that dropped mid-call.
- **Activity**: per call, metadata only (time, client, arm, tool, ok, ms, error); 30 days or 5,000 rows.

## Develop

Needs Node 22+ and a GitHub OAuth App with the callback `http://localhost:8787/callback`.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the OAuth App's id/secret and a random COOKIE_ENCRYPTION_KEY
npm run dev                      # wrangler dev on http://localhost:8787
npm run fake-arm -- --name birch # prints a pairing link; open it and click Connect
node tools/mcp-check.mjs --call fake_echo '{"text":"hi"}'   # OAuth in the browser, then tools/list + tools/call
```

`tools/mcp-check.mjs` is a scripted MCP client (what the MCP Inspector checks, without its UI). `npx @modelcontextprotocol/inspector` works too: point it at `http://localhost:8787/mcp`.

Tests: `npm test` (vitest in the Workers runtime, fake secrets, no network), `npm run type-check`.

## License

MIT
