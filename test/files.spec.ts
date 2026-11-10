import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FILE_MAX, FILES_PER_DAY, getFile, parseFileUrl, putFile, safeName } from '../src/files';
import indexSrc from '../src/index.ts?raw';
import mcpSrc from '../src/mcp.ts?raw';
import { ORIGIN, accessToken, connectArm, cookieFor, hub, mcpClient, newUser, pairArm } from './helpers';

async function armOf(cookie: string) {
  const { token } = await pairArm(cookie, 'chrome', 'poplar');
  const arm = await connectArm(token, { kind: 'chrome', name: 'poplar', selector: 'profile', tools: [] });
  await arm.ready;
  let n = 0;
  const keep = async (params: Record<string, unknown>) => {
    const id = `f${++n}`;
    arm.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'arm/file', params }));
    for (let i = 0; i < 100; i++) {
      const got = arm.received.find((m: any) => m.id === id) as any;
      if (got) return got;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no answer to ${id}`);
  };
  return { arm, keep };
}

describe('arm/file (fetch --out, net --har through the cloud)', () => {
  it('keeps a file and hands back a link that opens only for its owner, as a sandboxed attachment', async () => {
    const owner = newUser();
    const cookie = await cookieFor(owner);
    const { arm, keep } = await armOf(cookie);
    const res = await keep({ name: '/tmp/../cap ture.har', mimeType: 'application/json', text: '{"log":{"cookie":"secret"}}' });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ name: 'cap ture.har', mimeType: 'application/json', size: 27 });
    const url = new URL(res.result.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toMatch(/^\/files\/[A-Za-z0-9_-]{32}\/cap%20ture\.har$/);
    expect(Date.parse(res.result.expiresAt) - Date.now()).toBeGreaterThan(3500_000);

    // Not signed in: sign-in first, then back to the link.
    const anon = await hub(url.pathname, { redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('Location')).toBe(`${ORIGIN}/login?next=${encodeURIComponent(url.pathname)}`);
    // Another account: the same page as an expired link, no bytes.
    const other = await hub(url.pathname, { headers: { Cookie: await cookieFor(newUser()) } });
    expect(other.status).toBe(404);
    expect(await other.text()).toContain('This download link has expired');
    // The owner: the bytes, as an attachment that can't run on the hub's origin.
    const got = await hub(url.pathname, { headers: { Cookie: cookie } });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('{"log":{"cookie":"secret"}}');
    expect(got.headers.get('Content-Disposition')).toBe(`attachment; filename="cap ture.har"; filename*=UTF-8''cap%20ture.har`);
    expect(got.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(got.headers.get('Cache-Control')).toBe('private, no-store');
    arm.ws.close();
  });

  it('serves HTML and binaries as downloads too, and refuses bad or oversized input with the next step', async () => {
    const cookie = await cookieFor(newUser());
    const { arm, keep } = await armOf(cookie);
    const html = await keep({ name: 'page.html', mimeType: 'text/html', text: '<script>alert(1)</script>' });
    const page = await hub(new URL(html.result.url).pathname, { headers: { Cookie: cookie } });
    expect(page.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(page.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    const bin = await keep({ name: 'x.png', mimeType: 'image/png', data: btoa('\x89PNG\r\n') });
    expect(bin.result.size).toBe(6);
    const odd = await keep({ name: 'x', mimeType: 'not a type', text: 'hi' });
    expect(odd.result.mimeType).toBe('application/octet-stream');
    expect((await keep({ name: 'x' })).error.message).toBe('send the file as text or as base64 data');
    expect((await keep({ name: 'x', data: '***' })).error.message).toBe('data must be base64');
    const big = await keep({ name: 'big.bin', data: 'A'.repeat(Math.ceil(FILE_MAX / 3) * 4 + 8) });
    expect(big.error.message).toBe('the file is over 10 MB — Cloud Bridge keeps files up to 10 MB');
    arm.ws.close();
  });

  it('keeps files for a socket accepted before userId rode its attachment (they survive a deploy; found live)', async () => {
    const user = newUser();
    const cookie = await cookieFor(user);
    const { arm, keep } = await armOf(cookie);
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.uid));
    await runInDurableObject(stub, (_: unknown, state) => {
      for (const ws of state.getWebSockets()) {
        const { userId, ...old } = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment(old);
      }
    });
    const res = await keep({ name: 'late.txt', text: 'hi' });
    expect(res.error).toBeUndefined();
    const got = await hub(new URL(res.result.url).pathname, { headers: { Cookie: cookie } });
    expect(await got.text()).toBe('hi');
    arm.ws.close();
  });

  it(`keeps at most ${FILES_PER_DAY} files a day per account, and says the result still works without the file`, async () => {
    const cookie = await cookieFor(newUser());
    const { arm, keep } = await armOf(cookie);
    for (let i = 0; i < FILES_PER_DAY; i++) expect((await keep({ name: `f${i}.txt`, text: 'x' })).error).toBeUndefined();
    expect((await keep({ name: 'one-more.txt', text: 'x' })).error.message).toBe(`Cloud Bridge already kept ${FILES_PER_DAY} files for this account in the last 24 hours; the result itself still comes back without --out/--har`);
    arm.ws.close();
  });
});

describe('file store', () => {
  it('names files by their last path part, and an expired file is gone even before KV drops it', async () => {
    expect(safeName('C:\\Users\\me\\out.json')).toBe('out.json');
    expect(safeName('a"b\nc')).toBe('a_b_c');
    expect(safeName('')).toBe('download');
    const user = newUser().uid;
    const stale = await putFile(env.OAUTH_KV, user, ORIGIN, 'old.txt', 'text/plain', new Uint8Array([1]), Date.now() - 3601_000);
    expect(await getFile(env.OAUTH_KV, user, parseFileUrl(stale.url, ORIGIN)!)).toBeNull();
    expect(parseFileUrl('https://evil.test/files/' + 'a'.repeat(32) + '/x', ORIGIN)).toBeNull();
    expect(parseFileUrl(`${ORIGIN}/files/short/x`, ORIGIN)).toBeNull();
  });
});

// KV shows a write at once only in the location that made it (the user's
// Durable Object); a Worker elsewhere can read a fresh key as missing for a
// minute. Miniflare has one location, so pin the shape instead: the Worker
// reads files only through the DO (review finding).
describe('file reads go through the Durable Object', () => {
  it('index.ts and mcp.ts never read file KV themselves', () => {
    for (const [name, src] of [['index.ts', indexSrc], ['mcp.ts', mcpSrc]] as const) {
      expect(src, name).not.toMatch(/\bgetFile\b|OAUTH_KV\.get/);
      expect(src, name).toMatch(/\.readFile\(/);
    }
  });
});

describe('MCP resources', () => {
  it('lists the chrome-bridge manual and reads it as markdown', async () => {
    const client = await mcpClient(await accessToken(await cookieFor(newUser())));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['chrome-bridge://docs/SKILL.md', 'chrome-bridge://docs/reference/commands.md', 'chrome-bridge://docs/reference/recipes.md']);
    for (const r of resources) expect(r).toMatchObject({ mimeType: 'text/markdown', title: expect.stringContaining('chrome-bridge'), description: expect.stringContaining('pass what follows `node cli.mjs` to the chrome tool') });
    const skill = await client.readResource({ uri: 'chrome-bridge://docs/SKILL.md' });
    expect((skill.contents[0] as { text: string }).text).toMatch(/^---\nname: chrome-bridge/);
    await expect(client.readResource({ uri: 'chrome-bridge://docs/nope.md' })).rejects.toThrow('resources/list shows the manual');
    await client.close();
  });

  it("reads a file link for its owner over MCP (text as text, binaries as a blob), never another account's", async () => {
    const cookie = await cookieFor(newUser());
    const { arm, keep } = await armOf(cookie);
    const har = (await keep({ name: 'net.har', mimeType: 'application/json', text: '{"log":{}}' })).result.url;
    const png = (await keep({ name: 'x.png', mimeType: 'image/png', data: btoa('\x89PNG') })).result.url;
    const mine = await mcpClient(await accessToken(cookie));
    expect((await mine.readResource({ uri: har })).contents).toEqual([{ uri: har, mimeType: 'application/json', text: '{"log":{}}' }]);
    expect((await mine.readResource({ uri: png })).contents).toEqual([{ uri: png, mimeType: 'image/png', blob: btoa('\x89PNG') }]);
    const theirs = await mcpClient(await accessToken(await cookieFor(newUser())));
    await expect(theirs.readResource({ uri: har })).rejects.toThrow('This file link expired (links last an hour)');
    await mine.close();
    await theirs.close();
    arm.ws.close();
  });
});
