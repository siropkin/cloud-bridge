#!/usr/bin/env node
// Copies chrome-bridge's MCP tool list (extension/commands.js → TOOLS) into
// src/chrome-tools.json: the tools AI apps see BEFORE a Chrome is paired (they
// cache the list when the connector is added). A paired Chrome sends its own.
//
//   node tools/sync-chrome-tools.mjs [path/to/chrome-bridge] [--check] [--if-present]
//
// --check: exit 1 if the JSON differs (npm test runs this). --if-present: skip
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
const json = JSON.stringify(tools, null, 2) + '\n';
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
if (check) {
  if (current === json) {
    console.log(`chrome-tools: src/chrome-tools.json matches ${source} (${tools.length} tools)`);
    process.exit(0);
  }
  console.error(`chrome-tools: src/chrome-tools.json is out of date with ${source} — run: npm run sync-chrome-tools`);
  process.exit(1);
}
fs.writeFileSync(target, json);
console.log(`chrome-tools: wrote ${tools.length} tools to src/chrome-tools.json`);
