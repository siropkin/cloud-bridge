# Cloud Bridge

A free Cloudflare hub that lets cloud AIs (Claude.ai, ChatGPT, any remote-MCP client) use **arms** on your own machines. The first arm is your real, logged-in Chrome through the [chrome-bridge](https://github.com/siropkin/chrome-bridge) extension; local chrome-bridge keeps working beside it.

```
 AI clients ──MCP + OAuth──▶  Cloud Bridge (one Worker, one Durable Object per user)  ◀──WebSocket── arms
```

Status: preview. The hosted hub is **https://cloud-bridge.ivan-seredkin.workers.dev**: its home page is a three-step guide (install chrome-bridge, connect Chrome from its popup → ⚙ Settings → Cloud AI apps, add the connector to Claude or ChatGPT). `/add?app=claude|chatgpt` is that last step alone; the popup's Add to Claude / Add to ChatGPT buttons open it. `/app` is your own page once signed in (below).

## How it works

- **Sign-in**: GitHub. AI clients get OAuth 2.1 + PKCE from [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (dynamic registration; CIMD is off); a consent page names the client and where access is sent, and says so when an app calls itself Claude or ChatGPT but sends access elsewhere.
- **`/mcp`**: stateless Streamable HTTP (MCP SDK v2 through `agents`' `createMcpHandler`). `tools/list` merges the tools of your paired arms, prefixed with the arm kind (`echo` on a `fake` arm → `fake_echo`). Every tool carries the kind's selector argument (`arm`; chrome uses `profile`), even with one arm paired, so a list a client cached still works once a second one pairs; it's required only while several are online. Tool `annotations` (`readOnlyHint`…) pass through as the arm wrote them: AI apps use them to decide which calls need the user's OK.
- **Known kinds** (`src/kinds.ts`, today only `chrome`): their tools are listed even before one is paired, answering with how to connect one. Chrome's list is `src/chrome-tools.json`, generated from chrome-bridge's `extension/commands.js` by `npm run sync-chrome-tools` (`npm test` fails while it's out of date with a `../chrome-bridge` checkout, and skips the check without one). AI apps cache the tool list when the connector is added, so a Chrome paired later then needs no refresh. A paired arm's own tools replace them. The same file holds how pages name a kind ("Chrome profile “poplar”").
- **Arms** pair with a device code and then hold one outbound WebSocket to `/arm`:
  1. `POST /pair/start {"kind","name"}` → `{code, pollToken, verificationUri, expiresIn}`. A code lives 5 minutes.
  2. You open `verificationUri`, sign in and click Connect. The page leads with the decision ("Did you just click Connect in …?"); the code is the cross-check, and arms should show it where people can see it with the page open (chrome-bridge badges its toolbar icon with the first 4 characters). It also says when and roughly where the request started ("Started 2 minutes ago, from around Seattle, United States", Cloudflare's `request.cf` city, region and country of `/pair/start`, kept in the pairing record only, which the store deletes within about 20 minutes); when that country differs from the one the page opens from, it warns and makes Deny the main button, since the person who clicked Connect opens the page from the same browser.
  3. `POST /pair/poll {code, pollToken}` → `{armToken, armUrl}` (once).
  4. Connect to `armUrl` with subprotocols `cloud-bridge.v1` and `cbtoken.<armToken>`. A bad or revoked token is closed with code `4401`.
  - Signing out: `POST /arm/revoke` with `Authorization: Bearer <armToken>` → `{ok, revoked}`; the record and its socket go (`4401`). chrome-bridge calls it when Cloud AI apps is switched off and for its previous token when it pairs again, retrying while the hub is unreachable; the fake arm with `--revoke`. Pairing never replaces another record by name: two Chrome profiles can share one.
- **Arm protocol** (JSON-RPC 2.0 text frames): the arm sends `arm/hello {kind, name, version, selector?, offlineHint?}` once per connection (a second one closes the socket with `4400`: each hello writes the arm's record); the hub answers `arm/policy` and `arm/name {name}` (the name AI apps pick it by, which can differ from the arm's own after a rename on `/app`; sent again on every rename, so chrome-bridge accepts `--profile <that name>` inside a command line), then asks `tools/list`; MCP calls become `tools/call {name, arguments, _meta}`. Arms may ask the hub `arm/download {url}` → `{name, mimeType, data}` (base64, ≤10 MB, streamed and capped): chrome-bridge's cloud upload sends public URLs here instead of fetching them in the browser, which could reach the user's LAN; the hub runs on Cloudflare, outside the user's network, so its fetch can't reach their LAN (a worded refusal covers obvious private hosts for the model), and keeps nothing. Arms may also hand the hub a file they made for the user, `arm/file {name, mimeType, text | data}` → `{url, name, mimeType, size, expiresAt}` (≤10 MB, 50 a day per account): chrome-bridge's `fetch --out` / `net --har` through the cloud. The bytes live in KV for an hour under a key that carries the user id; `GET /files/<id>/<name>` asks for sign-in first and serves only the account that made it, as a sandboxed attachment (a HAR from a signed-in tab carries cookies, so the link must not work for anyone who sees it). Heartbeat: the text frame `ping` every 20s, answered `pong` without waking the Durable Object. A socket with no `ping` for 75s counts as offline and is closed with `4003` (its "last seen" is its last `ping`, not when the hub noticed), so a dead-but-open connection can't hang calls until the timeout; arms should likewise redial when `pong`s stop (chrome-bridge: after 70s).
- **Resources**: chrome-bridge's skill (`chrome-bridge://docs/SKILL.md`, `…/reference/commands.md`, `…/reference/recipes.md`), synced into `src/chrome-docs.json` by the same `npm run sync-chrome-tools`. `resources/read` also takes a file link (above), for the account that made it: text types come back as text, the rest as a base64 blob. The arm returns the link as an MCP `resource_link` too.
- **Your page (`/app`)**, signed in with GitHub: your connected Chrome profiles (online or not, version, last seen) with **Rename** (the name AI apps pick it by; unique per kind, any case; the arm keeps its own name and is told this one with `arm/name`) and **Disconnect** (the record and token go, the socket closes with `4401` at once, so chrome-bridge stops redialing and says so in its popup); the AI apps you allowed (name, where access goes, since when) with **Remove** (`revokeGrant`: the grant and all its tokens, so the app's next call is refused); the connector link with steps for Claude, ChatGPT, Claude Code and Cursor; **Sign out**; and **Delete my data** (a confirmation page, then: every grant revoked, every arm signed out with `4401`, the user's Durable Object storage deleted with `deleteAll()`, their files deleted from KV, the session cookie cleared; safe to run again after a failure part way). Every change is a form POST with a token bound to the account (HMAC of the user id) from the hub's own pages only (`Sec-Fetch-Site`/`Origin`), and answers with a redirect to a fixed message.
- **Errors are written for the model** and name the next step: no arm online, which arm to pick, an arm that dropped mid-call.
- **Storage**: OAuth state (registered apps, consent transactions, grants, tokens), pairing codes and web sign-ins live in Durable Objects (`src/store.ts`, the KV interface the OAuth library expects): grants and tokens in one object per user, the rest over 8 shards. Workers KV on the free plan takes 1,000 writes a day for the whole account, and anonymous requests used to spend them; SQLite Durable Objects take 100,000. KV holds only file links' bytes now (and OAuth keys from before the move, each moved over the first time it's read or listed; after 2027-02-08, when the last of them has expired, KV isn't consulted for them at all). Objects create their tables on the first real write, so a forged token's user id stores nothing.
- **Activity**: per call, metadata only (time, client, arm, tool name, ok, ms, and the hub's own error message; an arm's error text is never stored, since it can echo arguments); 30 days or 5,000 rows.
- **Limits** (`src/limits.ts`; the free plan's daily budgets are shared by every user of a hub):
  - Per network, on the routes anyone can call without signing in (Cloudflare's Rate Limiting binding, keyed by route and the caller's IPv4 address or IPv6 /64; per Cloudflare location and approximate): `/register`, `GET /authorize`, `/login`, `/callback` and `/pair/start` 10 a minute each; `/pair/poll`, `/arm` and `/arm/revoke` 60 a minute each. Signed in, but counted the same way, since each view lists grants and each change writes: `GET /app` and its rename, disconnect and remove 60 a minute each, delete 10. Over it: `429` with `Retry-After: 60` and the next step — a page for people, an OAuth error (`temporarily_unavailable`) for `/register`, `{"status":"slow_down"}` for `/pair/poll` (RFC 8628: keep polling, 5 seconds slower; the code stays valid), and a refused handshake (not an accepted-then-closed socket) for `/arm`, so a browser arm's backoff grows instead of resetting. Requests without `CF-Connecting-IP` (only tests and in-process calls; Cloudflare's edge always sets it) aren't counted, and a failing limiter lets requests through.
  - Per account: 120 tool calls a minute and 5,000 a day, counted from the activity rows plus calls still waiting for their arm (a refused call writes nothing and says when calls work again); 50 file links a day.
  - Per arm: 120 connections an hour (a plain `429` with `Retry-After` past that; the live connection stays).
  - For everyone: 800 file links per UTC day (each is a KV write, and free KV takes 1,000 a day for the whole account).

## Develop

Needs Node 22+ and a GitHub OAuth App with the callback `http://localhost:8787/callback`.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the OAuth App's id/secret and a random COOKIE_ENCRYPTION_KEY
npm run dev                      # wrangler dev on http://localhost:8787
npm run fake-arm -- --name birch # prints a pairing link; open it and click Connect
node tools/mcp-check.mjs --call fake_echo '{"text":"hi"}'   # OAuth in the browser, then tools/list, resources/list + tools/call
# --read <uri> reads a resource; --read link reads the file link the previous --call returned
```

`npm run dev` serves MCP at `http://localhost:8787/mcp` (it overrides `MCP_RESOURCE`, which wrangler.jsonc sets to the deployed URL; `.dev.vars` can't, because with `secrets` declared wrangler dev loads only those keys from it).

`tools/mcp-check.mjs` is a scripted MCP client (what the MCP Inspector checks, without its UI). `npx @modelcontextprotocol/inspector` works too: point it at `http://localhost:8787/mcp`. Both tools take `--hub <url>` to test a deployed hub.

Tests: `npm test` (vitest in the Workers runtime, fake secrets, no network), `npm run type-check`.

## Deploy your own

Free on Workers Free + `*.workers.dev`. The worker needs a KV namespace (file links), three secrets and its public URL; the Durable Objects come with the deploy (`migrations` in `wrangler.jsonc`):

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
