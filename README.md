# Cloud Bridge

A free Cloudflare hub that lets cloud AIs (Claude.ai, ChatGPT, any remote-MCP client) use **arms** on your own machines. The first arm is your real, logged-in Chrome through the [chrome-bridge](https://github.com/siropkin/chrome-bridge) extension; local chrome-bridge keeps working beside it.

```
 AI clients ──MCP + OAuth──▶  Cloud Bridge (one Worker, one Durable Object per user)  ◀──WebSocket── arms
```

Status: preview. The hosted hub is **https://cloud-bridge.ivan-seredkin.workers.dev**: its home page is a three-step guide (install chrome-bridge, connect Chrome from its popup → ⚙ Settings → Cloud AI apps, add the connector to Claude or ChatGPT). `/add?app=claude|chatgpt` is that last step alone; the popup's Add to Claude / Add to ChatGPT buttons open it.

## How it works

- **Sign-in**: GitHub. AI clients get OAuth 2.1 + PKCE from [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (dynamic registration and CIMD); a consent page names the client and where access is sent.
- **`/mcp`**: stateless Streamable HTTP (MCP SDK v2 through `agents`' `createMcpHandler`). `tools/list` merges the tools of your paired arms, prefixed with the arm kind (`echo` on a `fake` arm → `fake_echo`). With several arms of a kind, tools gain a selector argument (`arm`; chrome uses `profile`).
- **Known kinds** (`src/kinds.ts`, today only `chrome`): their tools are listed even before one is paired, answering with how to connect one. AI apps cache the tool list when the connector is added, so a Chrome paired later then needs no refresh. A paired arm's own tools replace them. The same file holds how pages name a kind ("Chrome profile “poplar”").
- **Arms** pair with a device code and then hold one outbound WebSocket to `/arm`:
  1. `POST /pair/start {"kind","name"}` → `{code, pollToken, verificationUri}`.
  2. You open `verificationUri`, sign in and click Connect. The page leads with the decision ("Did you just click Connect in …?"); the code is the cross-check, and arms should show it where people can see it with the page open (chrome-bridge badges its toolbar icon with the first 4 characters).
  3. `POST /pair/poll {code, pollToken}` → `{armToken, armUrl}` (once).
  4. Connect to `armUrl` with subprotocols `cloud-bridge.v1` and `cbtoken.<armToken>`. A bad or revoked token is closed with code `4401`.
  - Signing out: `POST /arm/revoke` with `Authorization: Bearer <armToken>` → `{ok, revoked}`; the record and its socket go (`4401`). chrome-bridge calls it when Cloud AI apps is switched off and for its previous token when it pairs again, retrying while the hub is unreachable; the fake arm with `--revoke`. Pairing never replaces another record by name: two Chrome profiles can share one.
- **Arm protocol** (JSON-RPC 2.0 text frames): the arm sends `arm/hello {kind, name, version, selector?, offlineHint?}`; the hub answers `arm/policy`, then asks `tools/list`; MCP calls become `tools/call {name, arguments, _meta}`. Heartbeat: the text frame `ping` every 20s, answered `pong` without waking the Durable Object. A socket with no `ping` for 75s counts as offline and is closed with `4003`, so a dead-but-open connection can't hang calls until the timeout; arms should likewise redial when `pong`s stop (chrome-bridge: after 70s).
- **Errors are written for the model** and name the next step: no arm online, which arm to pick, an arm that dropped mid-call.
- **Activity**: per call, metadata only (time, client, arm, tool name, ok, ms, and the hub's own error message; an arm's error text is never stored, since it can echo arguments); 30 days or 5,000 rows.

## Develop

Needs Node 22+ and a GitHub OAuth App with the callback `http://localhost:8787/callback`.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the OAuth App's id/secret and a random COOKIE_ENCRYPTION_KEY
npm run dev                      # wrangler dev on http://localhost:8787
npm run fake-arm -- --name birch # prints a pairing link; open it and click Connect
node tools/mcp-check.mjs --call fake_echo '{"text":"hi"}'   # OAuth in the browser, then tools/list + tools/call
```

`npm run dev` serves MCP at `http://localhost:8787/mcp` (it overrides `MCP_RESOURCE`, which wrangler.jsonc sets to the deployed URL; `.dev.vars` can't, because with `secrets` declared wrangler dev loads only those keys from it).

`tools/mcp-check.mjs` is a scripted MCP client (what the MCP Inspector checks, without its UI). `npx @modelcontextprotocol/inspector` works too: point it at `http://localhost:8787/mcp`. Both tools take `--hub <url>` to test a deployed hub.

Tests: `npm test` (vitest in the Workers runtime, fake secrets, no network), `npm run type-check`.

## Deploy your own

Free on Workers Free + `*.workers.dev`. The worker needs a KV namespace, three secrets and its public URL:

1. `npx wrangler kv namespace create OAUTH_KV`, then put the id in `wrangler.jsonc`.
2. Set `MCP_RESOURCE` in `wrangler.jsonc` to `https://cloud-bridge.<your-subdomain>.workers.dev/mcp`.
3. A GitHub OAuth App with the callback `https://cloud-bridge.<your-subdomain>.workers.dev/callback` (no scopes are requested: sign-in reads the public profile).
4. Run this as ONE command (pasted separately, a second line would be read as the secret). It asks for the client secret without echoing it, writes the secrets to a private file outside the repo, deploys with them (a Worker that doesn't exist yet can't take `wrangler secret put`, and the deploy refuses without them), and deletes the file on exit, even if the deploy fails:

   ```sh
   bash -c 'set -e; f=~/.cloud-bridge/prod-secrets.env; mkdir -p ~/.cloud-bridge; umask 077; trap "rm -f $f" EXIT; read -rsp "GitHub client secret: " S; echo; printf "GITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\nCOOKIE_ENCRYPTION_KEY=%s\n" "<client id>" "$S" "$(openssl rand -hex 32)" > "$f"; npx wrangler deploy --secrets-file "$f"'
   ```

   Later deploys are plain `npx wrangler deploy` (secrets persist); rotate one with `npx wrangler secret put NAME`.
5. A new `workers.dev` hostname answers `error code: 1042` ("There is nothing here yet") until it propagates: about 30 minutes for this hub's first deploy.

## License

MIT
