// Pure routing between hub tool names and arms. The hub never parses an arm's
// commands: arms describe their tools, and this file only namespaces them,
// picks the arm a call goes to, and words the errors for the model.
import { KNOWN_KINDS, type KnownKind } from './kinds';

export interface ArmTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  annotations?: Record<string, unknown>;
}

export interface ArmInfo {
  id: string;
  kind: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  tools: ArmTool[];
  // The argument that picks one arm of a kind when several are paired (chrome: "profile").
  selector: string;
  // What to tell the user when no arm of this kind is online.
  offlineHint: string | null;
}

export interface HubTool extends ArmTool {
  inputSchema: NonNullable<ArmTool['inputSchema']>;
}

export type Resolved =
  | { ok: true; arm: ArmInfo; tool: string; args: Record<string, unknown> }
  | { ok: false; error: string };

export function hubToolName(kind: string, tool: string): string {
  return tool === kind || tool.startsWith(kind + '_') ? tool : `${kind}_${tool}`;
}

// Most useful arm first: online, then most recently seen.
function ranked(arms: ArmInfo[]): ArmInfo[] {
  return [...arms].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

function byKind(arms: ArmInfo[]): Map<string, ArmInfo[]> {
  const kinds = new Map<string, ArmInfo[]>();
  for (const arm of ranked(arms)) kinds.set(arm.kind, [...(kinds.get(arm.kind) ?? []), arm]);
  return kinds;
}

// Tools of every PAIRED arm, online or not: a client that cached tools/list
// still gets a useful "start your arm" answer instead of "unknown tool". Known
// kinds with nothing paired yet list their tools too, so the list a client
// caches when the connector is added already has them. Annotations
// (readOnlyHint…) pass through as the arm wrote them: AI apps use them to
// decide which calls need the user's OK.
export function buildToolList(arms: ArmInfo[], known: Record<string, KnownKind> = KNOWN_KINDS): HubTool[] {
  const out: HubTool[] = [];
  const kinds = byKind(arms);
  for (const [kind, k] of Object.entries(known)) {
    if (kinds.has(kind)) continue;
    const pick = `Which ${kind} to use, by name, once the user has connected more than one. Leave it out otherwise.`;
    for (const tool of k.tools) out.push({ ...tool, name: hubToolName(kind, tool.name), inputSchema: withSelector(tool, k.selector, pick) });
  }
  for (const [kind, group] of kinds) {
    const seen = new Set<string>();
    // Offered even with one arm paired: AI apps cache the list, and a second
    // arm paired later must not need a refresh before the model can pick one.
    const pick =
      group.length > 1
        ? `Which ${kind} to use: ${names(group)}. Required while more than one is online.`
        : `Which ${kind} to use, by name (connected: ${names(group)}). Only needed once the user has connected more than one.`;
    for (const arm of group) {
      for (const tool of arm.tools) {
        const name = hubToolName(kind, tool.name);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ ...tool, name, inputSchema: withSelector(tool, group[0].selector, pick) });
      }
    }
  }
  return out;
}

function withSelector(tool: ArmTool, selector: string, description: string): HubTool['inputSchema'] {
  const schema = { type: 'object' as const, ...(tool.inputSchema ?? {}) };
  return { ...schema, properties: { ...(schema.properties ?? {}), [selector]: { type: 'string', description } } };
}

// Alphabetical: a stable list reads better to a model than connect order.
function names(arms: ArmInfo[]): string {
  return arms.map((a) => a.name).sort((a, b) => a.localeCompare(b)).join(', ');
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never connected';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `last seen ${s}s ago`;
  if (s < 90 * 60) return `last seen ${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `last seen ${Math.round(s / 3600)} h ago`;
  return `last seen ${Math.round(s / 86400)} days ago`;
}

function startHint(kind: string, arm: ArmInfo | undefined): string {
  return arm?.offlineHint ?? `Ask the user to start their ${kind} arm`;
}

// An offline arm is often one that is about to come back: the computer just woke
// or its network returned, and arms redial by themselves. Without this the model
// only had the person-facing fix, and sent the user to check settings that were
// fine (found live with Claude.ai after a night's sleep, 2026-11-10).
const REDIALS = 'It reconnects by itself within about a minute after the computer wakes up or its network comes back, so calling again in a minute may work.';

export function resolveCall(arms: ArmInfo[], hubName: string, args: Record<string, unknown>, now = Date.now(), known: Record<string, KnownKind> = KNOWN_KINDS): Resolved {
  const kinds = byKind(arms);
  for (const [kind, k] of Object.entries(known)) {
    if (!kinds.has(kind) && k.tools.some((t) => hubToolName(kind, t.name) === hubName)) return { ok: false, error: k.notConnected };
  }
  for (const [kind, group] of kinds) {
    const match = group.flatMap((arm) => arm.tools.filter((t) => hubToolName(kind, t.name) === hubName).map((t) => ({ arm, tool: t.name })));
    if (!match.length) continue;
    const selector = group[0].selector;
    const online = group.filter((a) => a.online);
    const onlineNames = names(online) || 'none';
    const { [selector]: wanted, ...rest } = args;
    let arm: ArmInfo | undefined;
    if (wanted !== undefined && wanted !== '') {
      arm = group.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase());
      if (!arm) return { ok: false, error: `No ${kind} named "${wanted}". Online: ${onlineNames}. Pass ${selector} as one of those names.` };
      if (!arm.online) {
        return {
          ok: false,
          error: `The ${kind} "${arm.name}" is offline (${ago(arm.lastSeen, now)}). Online: ${onlineNames}. ${REDIALS} If it doesn't: ${startHint(kind, arm)}, or pass ${selector} as one of the online names.`,
        };
      }
    } else if (online.length === 1) {
      arm = online[0];
    } else if (online.length === 0) {
      const paired = group.map((a) => `${a.name}, ${ago(a.lastSeen, now)}`).join('; ');
      return { ok: false, error: `No ${kind} is online (paired: ${paired}). ${REDIALS} If it doesn't: ${startHint(kind, group[0])}, then call this tool again.` };
    } else {
      return { ok: false, error: `Several ${kind}s are online: ${onlineNames}. Pass ${selector} with one of those names (ask the user which one if it isn't clear).` };
    }
    const tool = match.find((m) => m.arm.id === arm.id)?.tool;
    if (!tool) {
      const has = match.map((m) => m.arm.name).join(', ');
      return { ok: false, error: `The ${kind} "${arm.name}" doesn't offer ${hubName} (its version may be older). ${has} does: pass ${selector} as that name, or ask the user to update "${arm.name}".` };
    }
    return { ok: true, arm, tool, args: rest };
  }
  return { ok: false, error: `Unknown tool "${hubName}". Call tools/list for the current tools: the arm that offered it may have been unpaired.` };
}
