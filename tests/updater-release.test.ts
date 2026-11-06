import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRelease, downloadRelease, type VerifiedUpdate } from '../packages/updater/release.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const base = 'https://github.com/Always1010/CoCoProxy/releases/download/v1.1.0/';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(change: (metadata: any) => void = () => {}, signatureKey = privateKey) {
  const metadata: any = { schemaVersion: 1, repository: 'Always1010/CoCoProxy', version: '1.1.0', tag: 'v1.1.0',
    commit: 'a'.repeat(40), minimumNode: '22.18.0', minimumUpdater: 1, automatic: true, platforms: {} };
  for (const platform of ['linux-arm64', 'linux-amd64']) {
    const name = `cocoproxy-1.1.0-${platform}.tar.gz`;
    metadata.platforms[platform] = { name, url: base + name, size: 20, sha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64) };
  }
  change(metadata);
  const bytes = Buffer.from(JSON.stringify(metadata)), signature = sign(null, bytes, signatureKey);
  const assets = ['update.json', 'update.json.sig', ...Object.values(metadata.platforms).map((entry: any) => entry.name)]
    .map(name => ({ name, browser_download_url: base + name }));
  const fetcher = (async (url: string | URL | Request) => {
    const name = String(url).split('/').pop();
    return new Response(name === 'latest' ? JSON.stringify({ tag_name: 'v1.1.0', draft: false, prerelease: false, assets })
      : name === 'update.json' ? bytes : signature);
  }) as typeof fetch;
  return { metadata, bytes, signature, fetcher };
}
const signal = () => new AbortController().signal;

test('signed fixed-source stable update selects architecture and enforces compatibility', async () => {
  const { fetcher } = fixture();
  const update = await findRelease('1.0.2', 'linux-amd64', pem, signal(), { fetch: fetcher });
  assert.equal(update?.platform, 'linux-amd64'); assert.equal(update?.automatic, true);
  assert.equal(await findRelease('1.1.0', 'linux-arm64', pem, signal(), { fetch: fetcher }), null);
  assert.equal(await findRelease('2.0.0', 'linux-arm64', pem, signal(), { fetch: fetcher }), null);
  await assert.rejects(findRelease('1.0.2-dev', 'linux-arm64', pem, signal(), { fetch: fetcher }), /CURRENT_VERSION/);
  const incompatible = fixture(metadata => { metadata.minimumUpdater = 2; });
  assert.equal((await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: incompatible.fetcher }))?.automatic, false);
  assert.equal((await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fetcher, nodeVersion: '22.0.0' }))?.automatic, false);
});

test('wrong signature, tampering and signed identity/platform/host mismatches fail closed', async () => {
  const wrong = fixture(undefined, generateKeyPairSync('ed25519').privateKey);
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: wrong.fetcher }), /SIGNATURE/);
  const original = fixture();
  const tampered = (async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith('/update.json')
    ? new Response(Buffer.concat([original.bytes, Buffer.from(' ')])) : original.fetcher(url, init)) as typeof fetch;
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: tampered }), /SIGNATURE/);
  for (const change of [
    (m: any) => { m.version = '1.2.0'; },
    (m: any) => { m.platforms['linux-arm64'] = m.platforms['linux-amd64']; },
    (m: any) => { m.platforms['linux-arm64'].url = 'https://evil.invalid/archive'; },
  ]) await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fixture(change).fetcher }));
});

test('HTTPS redirects only permit explicit GitHub CDN hosts', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/leak' } }); }) as typeof fetch;
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fetcher }), /HOST/);
  assert.equal(calls, 1);
});

test('download checks signed package hash before extraction and rejects unsafe tar members', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-update-test-'));
  try {
    const update = (await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fixture().fetcher }))!;
    await assert.rejects(downloadRelease(update, join(directory, 'hash'), signal(), { fetch: (async () => new Response('bad')) as typeof fetch }), /HASH/);
    for (const kind of ['traversal', 'symlink', 'hardlink', 'fifo']) {
      const tar = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', `import tarfile,io,sys\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode='w:gz') as t:\n e=tarfile.TarInfo('../escape' if sys.argv[1]=='traversal' else 'cocoproxy-1.1.0-linux-arm64/x')\n e.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}.get(sys.argv[1],tarfile.REGTYPE)\n e.linkname='/tmp/escape'\n t.addfile(e)\nsys.stdout.buffer.write(b.getvalue())`, kind]);
      assert.equal(tar.status, 0);
      const signed: VerifiedUpdate = { ...update, asset: { ...update.asset, size: tar.stdout.length, sha256: sha256(tar.stdout) } };
      await assert.rejects(downloadRelease(signed, join(directory, kind), signal(), { fetch: (async () => new Response(tar.stdout)) as typeof fetch }), /EXTRACTION/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CI signer emits exact-byte detached signatures bound to both platform manifests', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { verify } = await import('node:crypto');
  // JavaScript build helper is checked separately with node --check.
  // @ts-ignore repository build scripts do not carry declaration files
  const { signUpdate } = await import('../scripts/sign-update.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-sign-test-'));
  try {
    for (const platform of ['linux-arm64', 'linux-amd64']) {
      const name = `cocoproxy-1.1.0-${platform}`;
      await writeFile(join(directory, name + '.tar.gz'), 'synthetic-archive');
      await writeFile(join(directory, name + '.manifest.json'), JSON.stringify({ commit: 'a'.repeat(40),
        components: { cocoproxy: { version: '1.1.0' }, mihomo: { platform: platform === 'linux-amd64' ? 'linux-amd64-v1' : platform } } }));
    }
    const metadata = await signUpdate({ directory, version: '1.1.0', tag: 'v1.1.0', commit: 'a'.repeat(40),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const bytes = await readFile(join(directory, 'update.json')), signature = await readFile(join(directory, 'update.json.sig'));
    assert.equal(signature.length, 64); assert.equal(verify(null, bytes, publicKey, signature), true);
    assert.equal(metadata.platforms['linux-amd64'].sha256, sha256(Buffer.from('synthetic-archive')));
    assert.equal(metadata.platforms['linux-arm64'].manifestSha256, sha256(await readFile(join(directory, 'cocoproxy-1.1.0-linux-arm64.manifest.json'))));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsigned newer releases and missing releases report distinct actionable errors', async () => {
  const unsigned = (async () => new Response(JSON.stringify({ tag_name: 'v1.1.0', draft: false, prerelease: false, assets: [] }))) as typeof fetch;
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: unsigned }), (error: any) =>
    error.code === 'UPDATE_UNSIGNED_RELEASE' && error.version === '1.1.0');
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), {
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  }), (error: any) => error.code === 'UPDATE_RELEASE_UNAVAILABLE');
});

test('conditional discovery uses bounded cached bytes and rate limiting exposes retry deadline', async () => {
  const original = fixture(); let cachedCalls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const previous = new Headers(init?.headers).get('if-none-match');
    if (previous) { assert.equal(previous, '"fixture-v1"'); cachedCalls++; return new Response(null, { status: 304 }); }
    const response = await original.fetcher(url, init);
    return new Response(await response.arrayBuffer(), { headers: { etag: '"fixture-v1"' } });
  }) as typeof fetch;
  await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fetcher });
  assert.equal((await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fetcher }))?.version, '1.1.0');
  assert.equal(cachedCalls, 3);
  const before = Date.now();
  await assert.rejects(findRelease('1.0.2', 'linux-arm64', pem, signal(), {
    fetch: (async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch,
  }), (error: any) => error.code === 'UPDATE_RATE_LIMITED' && error.retryAt >= before + 120_000);
});

test('streamed valid payload passes complete existing manifest verification and identity binding', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-valid-update-'));
  try {
    const root = join(directory, 'cocoproxy-1.1.0-linux-arm64');
    const entries = [];
    for (const path of ['bin/mihomo', 'source/apps/runtime/launch-core.ts', 'server/.output/server/index.mjs']) {
      const bytes = Buffer.from('synthetic fixture only\n');
      await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), bytes);
      entries.push({ path, sha256: sha256(bytes), size: bytes.length, mode: '0644' });
    }
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, scope: 'local-explicit-proxy-payload', commit: 'a'.repeat(40), files: entries,
      components: { cocoproxy: { version: '1.1.0' }, mihomo: { platform: 'linux-arm64', binarySha256: entries[0].sha256 } } }));
    await writeFile(join(root, 'manifest.json'), manifest);
    const archivePath = join(directory, 'fixture.tar.gz');
    const tar = spawnSync('tar', ['-czf', archivePath, '-C', directory, 'cocoproxy-1.1.0-linux-arm64']);
    assert.equal(tar.status, 0);
    const bytes = await readFile(archivePath);
    const initial = (await findRelease('1.0.2', 'linux-arm64', pem, signal(), { fetch: fixture().fetcher }))!;
    const update = { ...initial, manifestSha256: sha256(manifest), asset: { ...initial.asset, size: bytes.length, sha256: sha256(bytes) } };
    const fetcher = (async () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.subarray(offset, offset + 17));
      controller.close();
    } }))) as typeof fetch;
    const downloaded = await downloadRelease(update, join(directory, 'download'), signal(), { fetch: fetcher });
    assert.equal(downloaded.manifestSha256, sha256(manifest));
    assert.deepEqual(await readFile(join(downloaded.payload, 'manifest.json')), manifest);
    await assert.rejects(downloadRelease({ ...update, commit: 'd'.repeat(40) }, join(directory, 'wrong-commit'), signal(), { fetch: fetcher }), /IDENTITY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
