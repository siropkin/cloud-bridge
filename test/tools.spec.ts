import { describe, expect, it } from 'vitest';
import { ago, buildToolList, hubToolName, resolveCall, type ArmInfo } from '../src/tools';

const T = (name: string) => ({ name, inputSchema: { type: 'object' as const, properties: { x: { type: 'string' } } } });
const arm = (o: Partial<ArmInfo>): ArmInfo => ({ id: o.name ?? 'a', kind: 'chrome', name: 'birch', online: true, lastSeen: 1, tools: [T('chrome'), T('snap')], selector: 'profile', offlineHint: 'Ask the user to open Chrome', ...o });

describe('hubToolName', () => {
  it('prefixes with the kind unless the tool already carries it', () => {
    expect(hubToolName('fake', 'echo')).toBe('fake_echo');
    expect(hubToolName('fake', 'fake_snap')).toBe('fake_snap');
    expect(hubToolName('chrome', 'chrome')).toBe('chrome');
    expect(hubToolName('chrome', 'chromebook')).toBe('chrome_chromebook');
  });
});

describe('buildToolList', () => {
  it('lists each tool once per kind, always with the selector (a cached list must survive a second pairing)', () => {
    const one = buildToolList([arm({})]);
    expect(one.map((t) => t.name)).toEqual(['chrome', 'chrome_snap']);
    expect((one[0].inputSchema.properties as any).profile.description).toBe('Which chrome to use, by name (connected: birch). Only needed once the user has connected more than one.');
    expect(one[0].inputSchema.properties).toHaveProperty('x');
    const two = buildToolList([arm({ name: 'birch' }), arm({ name: 'oak', id: 'oak' })]);
    expect(two.map((t) => t.name)).toEqual(['chrome', 'chrome_snap']);
    expect((two[0].inputSchema.properties as any).profile.description).toContain('birch, oak');
  });
  it('passes the arm\'s annotations and title through untouched', () => {
    const tool = { ...T('snap'), title: 'Read a tab', annotations: { readOnlyHint: true, destructiveHint: false } };
    expect(buildToolList([arm({ tools: [tool] })])[0]).toMatchObject({ name: 'chrome_snap', title: 'Read a tab', annotations: { readOnlyHint: true, destructiveHint: false } });
  });
  it('keeps offline arms\' tools listed so a cached client gets a next-step error', () => {
    expect(buildToolList([arm({ online: false })]).map((t) => t.name)).toEqual(['chrome', 'chrome_snap']);
  });
});

describe('resolveCall', () => {
  const now = 10 * 60_000;
  it('routes to the only online arm and strips the selector', () => {
    const r = resolveCall([arm({}), arm({ name: 'oak', id: 'oak', online: false })], 'chrome_snap', { x: '1' }, now);
    expect(r).toMatchObject({ ok: true, tool: 'snap', args: { x: '1' }, arm: { name: 'birch' } });
  });
  it('names the start step when nothing is online', () => {
    const r = resolveCall([arm({ online: false, lastSeen: now - 5 * 60_000 })], 'chrome', {}, now);
    expect(r).toEqual({ ok: false, error: 'No chrome is online (paired: birch, last seen 5 min ago). Ask the user to open Chrome, then call this tool again.' });
  });
  it('asks for the selector when several are online, and honours it case-insensitively', () => {
    const arms = [arm({ name: 'birch' }), arm({ name: 'oak', id: 'oak' })];
    const r = resolveCall(arms, 'chrome', {}, now);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('Several chromes are online: birch, oak. Pass profile');
    expect(resolveCall(arms, 'chrome', { profile: 'OAK' }, now)).toMatchObject({ ok: true, arm: { name: 'oak' } });
  });
  it('explains an unknown or offline selector', () => {
    const arms = [arm({ name: 'birch' }), arm({ name: 'oak', id: 'oak', online: false, lastSeen: now - 3 * 3600_000 })];
    expect(resolveCall(arms, 'chrome', { profile: 'elm' }, now)).toMatchObject({ ok: false, error: 'No chrome named "elm". Online: birch. Pass profile as one of those names.' });
    const r = resolveCall(arms, 'chrome', { profile: 'oak' }, now);
    expect(!r.ok && r.error).toContain('The chrome "oak" is offline (last seen 3 h ago). Online: birch.');
  });
  it('says which arm has a tool another arm lacks', () => {
    const r = resolveCall([arm({ name: 'birch', tools: [T('chrome')] }), arm({ name: 'oak', id: 'oak', online: false })], 'chrome_snap', {}, now);
    expect(!r.ok && r.error).toContain(`The chrome "birch" doesn't offer chrome_snap`);
  });
  it('rejects unknown tools with the next step', () => {
    expect(resolveCall([arm({})], 'nope', {}, now)).toMatchObject({ ok: false, error: expect.stringContaining('Call tools/list') });
  });
});

describe('ago', () => {
  it('formats', () => {
    expect(ago(null)).toBe('never connected');
    expect(ago(0 + 1, 1 + 30_000)).toBe('last seen 30s ago');
    expect(ago(1, 1 + 3 * 86400_000)).toBe('last seen 3 days ago');
  });
});

describe('known kinds before any arm is paired', () => {
  const known = { chrome: { label: 'Chrome profile', connectWhere: 'x', codeWhere: 'x', tools: [T('chrome')], selector: 'profile', notConnected: 'Install it, then connect.' } };
  it('lists the kind\'s tools only while none of that kind is paired', () => {
    expect(buildToolList([], known).map((t) => t.name)).toEqual(['chrome']);
    expect(buildToolList([arm({ tools: [T('chrome'), T('snap')] })], known).map((t) => t.name)).toEqual(['chrome', 'chrome_snap']);
    expect(buildToolList([arm({ kind: 'fake', tools: [T('echo')] })], known).map((t) => t.name)).toEqual(['chrome', 'fake_echo']);
  });
  it('offers the selector before any pairing too', () => {
    expect((buildToolList([], known)[0].inputSchema.properties as any).profile.description).toMatch(/^Which chrome to use, by name, once the user has connected more than one/);
  });
  it('ships chrome-bridge\'s typed tools with their read-only hints', () => {
    const tools = buildToolList([]);
    expect(tools.map((t) => t.name)).toEqual(['chrome', 'chrome_batch', 'chrome_tabs', 'chrome_snap', 'chrome_shot', 'chrome_measure', 'chrome_wait', 'chrome_release', 'chrome_open', 'chrome_nav', 'chrome_click', 'chrome_fill', 'chrome_press', 'chrome_upload', 'chrome_close']);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['chrome_tabs', 'chrome_snap', 'chrome_shot', 'chrome_measure', 'chrome_wait', 'chrome_release']);
    expect(tools.every((t) => !('command' in t))).toBe(true);
    for (const t of tools) expect(resolveCall([], t.name, {}, 0)).toMatchObject({ ok: false, error: expect.stringContaining('No Chrome is connected') });
  });
  it('answers a call with how to connect one', () => {
    expect(resolveCall([], 'chrome', {}, 0, known)).toEqual({ ok: false, error: 'Install it, then connect.' });
    expect(resolveCall([arm({ online: false })], 'chrome', {}, 0, known)).toMatchObject({ ok: false, error: expect.stringContaining('No chrome is online') });
  });
});
