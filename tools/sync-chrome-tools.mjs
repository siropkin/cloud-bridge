#!/usr/bin/env node
// Copies from a chrome-bridge checkout what the hub serves before (or without)
// asking a paired Chrome:
//   - extension/commands.js → TOOLS into src/chrome-tools.json: the tools AI
//     apps see BEFORE a Chrome is paired (they cache the list when the
//     connector is added). A paired Chrome sends its own.
//   - the chrome-bridge skill (SKILL.md, reference/*.md) into
//     src/chrome-docs.json: the manual, served as MCP resources.
//
//   node tools/sync-chrome-tools.mjs [path/to/chrome-bridge] [--check] [--if-present]
//
// --check: exit 1 if either JSON differs (npm test runs this). --if-present: skip
// quietly when the chrome-bridge checkout isn't there (CI clones only this repo).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const ifPresent = args.includes('--if-present');
const repo = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(here, '..', '..', 'chrome-bridge'));
const source = path.join(repo, 'extension', 'commands.js');
const target = path.join(here, '..', 'src', 'chrome-tools.json');

if (!fs.existsSync(source)) {
  if (ifPresent) {
    console.log(`chrome-tools: no chrome-bridge checkout at ${repo}, skipped`);
    process.exit(0);
  }
  console.error(`chrome-tools: ${source} not found — pass the chrome-bridge checkout path`);
  process.exit(1);
}
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(source, 'utf8'), context);
const tools = JSON.parse(JSON.stringify(context.BridgeCommands.TOOLS)).map(({ command, ...t }) => t);

// Served as-is: the grammar is the CLI's, and the chrome tool takes those lines.
const CLOUD_NOTE = 'Written for the local CLI: through Cloud Bridge, pass what follows `node cli.mjs` to the chrome tool (or use the chrome_* tools). Commands that manage the local install are refused there.';
const DOCS = [
  { file: 'SKILL.md', title: 'chrome-bridge manual: start here', description: `How to drive the user's Chrome well: the core loop (find the tab, snap, act, verify), refs, waits, hand-offs and etiquette. ${CLOUD_NOTE}` },
  { file: 'reference/commands.md', title: 'chrome-bridge command reference', description: `Every command and flag with its exact syntax, plus per-command notes. ${CLOUD_NOTE}` },
  { file: 'reference/recipes.md', title: 'chrome-bridge recipes and gotchas', description: `Worked recipes (logins, forms, rich editors, uploads, network capture, local + cloud at once) and known traps. ${CLOUD_NOTE}` },
];
const skill = path.join(repo, '.claude', 'skills', 'chrome-bridge');
const docs = DOCS.map((d) => ({ uri: `chrome-bridge://docs/${d.file}`, name: d.file, title: d.title, description: d.description, mimeType: 'text/markdown', text: fs.readFileSync(path.join(skill, d.file), 'utf8') }));

const outputs = [
  { target, json: JSON.stringify(tools, null, 2) + '\n', what: `${tools.length} tools`, from: source },
  { target: path.join(here, '..', 'src', 'chrome-docs.json'), json: JSON.stringify(docs, null, 2) + '\n', what: `${docs.length} docs`, from: skill },
];
let stale = 0;
for (const o of outputs) {
  const rel = path.relative(path.join(here, '..'), o.target);
  const current = fs.existsSync(o.target) ? fs.readFileSync(o.target, 'utf8') : '';
  if (!check) {
    fs.writeFileSync(o.target, o.json);
    console.log(`chrome-tools: wrote ${o.what} to ${rel}`);
  } else if (current === o.json) console.log(`chrome-tools: ${rel} matches ${o.from} (${o.what})`);
  else {
    console.error(`chrome-tools: ${rel} is out of date with ${o.from} — run: npm run sync-chrome-tools`);
    stale++;
  }
}
process.exit(stale ? 1 : 0);
