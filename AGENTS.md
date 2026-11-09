# cloud-bridge — agent instructions

The hub of Cloud Bridge. Arms (first: the [chrome-bridge](https://github.com/siropkin/chrome-bridge) extension) connect out to it; cloud AIs reach them through `/mcp`. Read [README.md](README.md) for the shape.

## Layout

- `src/index.ts`: the Worker. `OAuthProvider` wraps everything: `/mcp` → `src/mcp.ts`; the rest → the router (`/`, `/add`, `/authorize`, `/callback`, `/login`, `/logout`, `/pair*`, `/arm`, `/arm/revoke`). No static assets: the worker serves `/` so it can show its own connector link.
- `src/auth.ts`: GitHub sign-in (PKCE), the hub's web session cookie, the MCP consent page. One `/callback` serves both flows: web-login states start with `w.`, the rest go through the library's `finishUpstream()`.
- `src/pair.ts`: device-code pairing. `src/hub.ts`: `UserHub`, one SQLite Durable Object per user (arms, activity, hibernatable arm sockets, RPC `listTools`/`callTool`/`revokeArm`/`armSummary`). `src/tools.ts`: pure naming/routing/error wording, the place to change what models read. `src/kinds.ts`: the one deliberate exception to arm-agnostic: known kinds' tools before one is paired and how pages name them. `src/guide.ts`: the people pages (`/`, `/add`, the step after pairing); re-check Claude's and ChatGPT's connector menus when touching them.
- `tools/fake-arm.mjs` (zero-dependency arm) and `tools/mcp-check.mjs` (scripted MCP client with real OAuth).

## Developing

- Product bar: an AI-first, open-source tool that anyone — not only IT people — can set up and use, and that AI agents love to use. Pages a person sees speak plain words with one obvious next action (no "arm", "hub", "pair", "MCP": `test/hub.spec.ts` checks the pages); everything a model reads names the next step.
- Server `instructions` and tool descriptions are descriptive, never orders to the model: Claude read "tell the user exactly…" as a possible prompt injection.
- Gates before pushing: `npm test`, `npm run type-check`, `npx wrangler deploy --dry-run`. A protocol or auth change also gets a live run: `npm run dev` + `npm run fake-arm` + `node tools/mcp-check.mjs --call fake_echo '{"text":"hi"}'`.
- Fetch current docs before touching Cloudflare, `@cloudflare/workers-oauth-provider` (its `docs/` folder in node_modules is current), `agents` or the MCP SDK: these move fast. After a `wrangler.jsonc` change run `npm run cf-typegen` and commit `worker-configuration.d.ts`.
- The hub stays arm-agnostic: it never parses an arm's commands. Arms describe themselves (`arm/hello`, `tools/list`).
- Errors are for a model: every refusal says what to do next. Tests pin the exact wording; change both together.
- Free tier only (Workers Free, `*.workers.dev`). Never deploy, create cloud resources (KV namespaces, secrets, OAuth Apps) or add connectors without the owner's approval.
- Secrets live in `.dev.vars` (git-ignored) or `wrangler secret put`; never print, log or commit them. Tests use fake bindings from `vitest.config.ts` (a test asserts they override `.dev.vars`).
- Docs are load-bearing: a behavior change updates README.md and this file in the same commit. Arm-protocol changes also need the chrome-bridge side (its docs and version).
- Commits: `area: what — why`; the body says what it risked and how it was verified.
- Style: 2-space indent, single quotes, semicolons, long lines fine (same as chrome-bridge).
