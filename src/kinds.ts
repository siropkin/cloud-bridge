import type { ArmTool } from './tools';
import chromeTools from './chrome-tools.json';

// What the hub knows about arm kinds it ships for. The hub still never parses an
// arm's commands; this only covers what people and models see BEFORE an arm of
// the kind is paired (a connector added first must already list chrome's tools:
// Claude.ai caches the list from the moment it's added) and how pages name it.
export interface KnownKind {
  // People's words: "Chrome profile “poplar”".
  label: string;
  // Where the person clicked Connect, and where the arm shows its pairing code.
  connectWhere: string;
  codeWhere: string;
  // Listed while no arm of this kind is paired; a paired arm's own tools replace them.
  tools: ArmTool[];
  // The argument that picks one arm of the kind (what its arms send in arm/hello).
  selector: string;
  // The answer to a call while none is paired.
  notConnected: string;
}

export const CHROME_STORE = 'https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg';

export const KNOWN_KINDS: Record<string, KnownKind> = {
  chrome: {
    label: 'Chrome profile',
    connectWhere: 'the chrome-bridge extension',
    // The extension badges its toolbar icon with the code's first 4 characters (the popup closes when this page opens).
    codeWhere: 'The chrome-bridge icon in your Chrome toolbar',
    // Generated from chrome-bridge's extension/commands.js: npm run sync-chrome-tools (npm test checks it).
    tools: chromeTools as ArmTool[],
    selector: 'profile',
    notConnected: `No Chrome is connected to the user's Cloud Bridge yet, so nothing ran. The user connects one in two steps: install the chrome-bridge extension (${CHROME_STORE}), then click its toolbar icon → ⚙ Settings → Cloud AI apps → Connect. Once they have, call this tool again.`,
  },
};

const capitalized = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

// "Chrome profile “poplar”", or "Fake “birch”" for a kind the hub doesn't know.
export function armLabel(kind: string, name: string): string {
  return `${kindLabel(kind)} “${name}”`;
}

// What people call one arm of this kind ("Chrome profile").
export function kindLabel(kind: string): string {
  return KNOWN_KINDS[kind]?.label ?? capitalized(kind);
}

// "Chrome" for the consent title; unknown kinds by their capitalized name.
export function kindName(kind: string): string {
  return kind === 'chrome' ? 'Chrome' : capitalized(kind);
}

export function connectWhere(kind: string): string {
  return KNOWN_KINDS[kind]?.connectWhere ?? 'the app that sent you here';
}

export function codeWhere(kind: string): string {
  return KNOWN_KINDS[kind]?.codeWhere ?? 'The app that sent you here';
}
