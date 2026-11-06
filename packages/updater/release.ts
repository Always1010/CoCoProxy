import { createHash } from 'node:crypto';
import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export type Platform = 'linux-arm64' | 'linux-amd64';
export type VerifiedUpdate = {
  version: string; tag: string; commit: string; platform: Platform; manifestSha256: string;
  asset: { name: string; url: string; size: number; sha256: string }; automatic: boolean;
};
type Dependencies = { fetch?: typeof fetch; nodeVersion?: string };
const repository = 'Always1010/CoCoProxy';
const origin = `https://github.com/${repository}/releases/download/`;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function version(value: string): bigint[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.length > 100) return null;
  return value.split('.').map(BigInt);
}
function compare(a: string, b: string) {
  const left = version(a), right = version(b);
  need(left && right, 'UPDATE_VERSION_INVALID');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function allowedURL(value: string, redirected: boolean) {
  const url = new URL(value);
  need(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash,
    'UPDATE_URL_INVALID');
  const direct = url.hostname === 'api.github.com' && url.pathname === `/repos/${repository}/releases/latest`
    || url.hostname === 'github.com' && url.pathname.startsWith(`/${repository}/releases/download/`) && !url.search;
  const cdn = redirected && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
  need(direct || cdn, 'UPDATE_HOST_INVALID');
  return url;
}
export class UpdateReleaseError extends Error {
  code: string; retryAt?: number; version?: string;
  constructor(code: string, retryAt?: number, version?: string) {
    super(code); this.name = 'UpdateReleaseError'; this.code = code; this.retryAt = retryAt; this.version = version;
  }
}
type CachedResponse = { etag: string; bytes: Buffer };
// Each fetch implementation retains at most three small discovery documents.
const discoveryCache = new WeakMap<typeof fetch, Map<string, CachedResponse>>();
async function request(url: string, limit: number, signal: AbortSignal, fetcher: typeof fetch,
  sink?: (chunk: Uint8Array) => Promise<void>, conditional = false): Promise<Buffer> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const original = url;
  let cache = discoveryCache.get(fetcher);
  if (!cache) { cache = new Map(); discoveryCache.set(fetcher, cache); }
  const cached = conditional ? cache.get(original) : undefined;
  for (let redirects = 0; redirects <= 4; redirects++) {
    allowedURL(url, redirects > 0);
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'CoCoProxy-updater' };
    if (cached && redirects === 0) headers['If-None-Match'] = cached.etag;
    const response = await fetcher(url, { signal: bounded, redirect: 'manual', headers });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      need(redirects < 4 && response.headers.has('location'), 'UPDATE_REDIRECT_INVALID');
      url = new URL(response.headers.get('location')!, url).href; continue;
    }
    if (response.status === 304) {
      await response.body?.cancel(); need(cached && conditional, 'UPDATE_CACHE_INVALID'); return cached.bytes;
    }
    if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
      || response.status === 503 && response.headers.has('retry-after')) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after'), reset = response.headers.get('x-ratelimit-reset');
      const at = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry))
        : reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
      throw new UpdateReleaseError('UPDATE_RATE_LIMITED', Number.isSafeInteger(at) && at > Date.now() ? at : Date.now() + 60_000);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UpdateReleaseError(response.status === 404 ? 'UPDATE_RELEASE_UNAVAILABLE' : 'UPDATE_HTTP_FAILED');
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body.cancel(); throw new UpdateReleaseError('UPDATE_SIZE_LIMIT');
    }
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        bounded.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; need(size <= limit, 'UPDATE_SIZE_LIMIT');
        if (sink) await sink(part.value); else chunks.push(Buffer.from(part.value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const bytes = Buffer.concat(chunks);
    const etag = response.headers.get('etag');
    if (conditional && etag && etag.length <= 256) {
      if (cache.size >= 3 && !cache.has(original)) cache.delete(cache.keys().next().value!);
      cache.set(original, { etag, bytes });
    } else if (conditional) cache.delete(original);
    return bytes;
  }
  throw new Error('UPDATE_REDIRECT_INVALID');
}
export async function findRelease(currentVersion: string, platform: Platform, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<VerifiedUpdate | null> {
  need(version(currentVersion), 'UPDATE_CURRENT_VERSION_INVALID');
  need(['linux-arm64', 'linux-amd64'].includes(platform), 'UPDATE_PLATFORM_INVALID');
  const fetcher = dependencies.fetch ?? fetch;
  const release = JSON.parse((await request(`https://api.github.com/repos/${repository}/releases/latest`, 1024 * 1024, signal, fetcher, undefined, true)).toString());
  need(!release.draft && !release.prerelease && typeof release.tag_name === 'string', 'UPDATE_RELEASE_INVALID');
  const candidate = release.tag_name.replace(/^v/, '');
  if (!version(candidate) || release.tag_name !== `v${candidate}` || compare(candidate, currentVersion) <= 0) return null;
  const base = `${origin}${release.tag_name}/`;
  need(Array.isArray(release.assets), 'UPDATE_ASSETS_INVALID');
  const asset = (name: string) => {
    const matches = release.assets.filter((asset: any) => asset.name === name);
    need(matches.length === 1 && matches[0].browser_download_url === base + name, 'UPDATE_ASSET_INVALID');
    return matches[0] as { name: string; browser_download_url: string; digest?: string | null; size: number };
  };
  // Release identity comes from the fixed GitHub repository over verified HTTPS.
  // GitHub asset digests bind downloaded bytes without per-device keys or credentials.
  if (!release.assets.some((asset: any) => asset.name === 'update.json')) throw new UpdateReleaseError('UPDATE_METADATA_UNAVAILABLE', undefined, candidate);
  let sums: Map<string, string> | undefined;
  const assetDigest = async (entry: ReturnType<typeof asset>): Promise<string> => {
    if (entry.digest !== undefined && entry.digest !== null) {
      need(typeof entry.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(entry.digest), 'UPDATE_ASSET_DIGEST_INVALID');
      return entry.digest.slice('sha256:'.length);
    }
    // Earlier GitHub assets may lack a digest. Use the same release's existing checksum file.
    if (!sums) {
      const checksums = asset('SHA256SUMS');
      const raw = await request(checksums.browser_download_url, 256 * 1024, signal, fetcher, undefined, true);
      if (checksums.digest !== undefined && checksums.digest !== null) {
        need(typeof checksums.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(checksums.digest)
          && createHash('sha256').update(raw).digest('hex') === checksums.digest.slice('sha256:'.length), 'UPDATE_CHECKSUMS_HASH_MISMATCH');
      }
      sums = new Map();
      for (const line of raw.toString('utf8').split('\n')) {
        if (!line) continue;
        const match = /^([a-f0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(line);
        need(match && !sums.has(match[2]), 'UPDATE_CHECKSUMS_INVALID');
        sums.set(match[2], match[1]);
      }
    }
    const digest = sums.get(entry.name);
    need(digest, 'UPDATE_ASSET_DIGEST_MISSING');
    return digest;
  };
  const metadataAsset = asset('update.json');
  const bytes = await request(metadataAsset.browser_download_url, 1024 * 1024, signal, fetcher, undefined, true);
  need(createHash('sha256').update(bytes).digest('hex') === await assetDigest(metadataAsset), 'UPDATE_METADATA_HASH_MISMATCH');
  const metadata = JSON.parse(bytes.toString());
  need(metadata.schemaVersion === 1 && metadata.repository === repository && metadata.version === candidate && metadata.tag === release.tag_name
    && /^[a-f0-9]{40}$/.test(metadata.commit) && version(metadata.minimumNode) && Number.isSafeInteger(metadata.minimumUpdater)
    && metadata.minimumUpdater >= 1 && typeof metadata.automatic === 'boolean', 'UPDATE_METADATA_INVALID');
  const entry = metadata.platforms?.[platform];
  const name = `cocoproxy-${candidate}-${platform}.tar.gz`;
  const packageAsset = asset(name);
  need(entry && entry.name === name && entry.url === packageAsset.browser_download_url && Number.isSafeInteger(entry.size)
    && entry.size === packageAsset.size && entry.size > 0 && entry.size <= 256 * 1024 * 1024
    && sha(entry.sha256) && sha(entry.manifestSha256), 'UPDATE_PACKAGE_INVALID');
  need(entry.sha256 === await assetDigest(packageAsset), 'UPDATE_PACKAGE_DIGEST_MISMATCH');
  return { version: candidate, tag: metadata.tag, commit: metadata.commit, platform, manifestSha256: entry.manifestSha256,
    asset: { name, url: entry.url, size: entry.size, sha256: entry.sha256 },
    automatic: metadata.automatic && metadata.minimumUpdater <= 1 && compare(dependencies.nodeVersion ?? process.versions.node, metadata.minimumNode) >= 0 };
}

// Read only bounded regular tar members. Never invoke code from the archive.
const extractor = String.raw`
import tarfile, pathlib, sys, os, gzip, tempfile
archive, destination, expected = sys.argv[1:]
root = pathlib.Path(destination)
seen = set(); total = 0; count = 0
raw = tempfile.TemporaryFile(dir=destination)
expanded = 0
with gzip.open(archive, 'rb') as compressed:
 while True:
  block = compressed.read(1024*1024)
  if not block: break
  expanded += len(block)
  if expanded > 550*1024*1024: raise ValueError('tar expansion limit')
  raw.write(block)
raw.seek(0)
with tarfile.open(fileobj=raw, mode='r:') as tar:
 for entry in tar:
  count += 1
  if count > 16000: raise ValueError('member limit')
  parts = entry.name.rstrip('/').split('/')
  if not parts or parts[0] != expected or any(p in ('', '.', '..', '.local') for p in parts) or '\\' in entry.name: raise ValueError('unsafe path')
  if not entry.isdir() and not entry.isfile(): raise ValueError('unsafe member')
  if entry.name.rstrip('/').lower() in seen: raise ValueError('duplicate member')
  seen.add(entry.name.rstrip('/').lower())
  path = root.joinpath(*parts)
  if entry.isdir():
   path.mkdir(parents=True, exist_ok=True); continue
  if entry.size < 0 or entry.size > 256*1024*1024: raise ValueError('file limit')
  total += entry.size
  if total > 512*1024*1024: raise ValueError('expanded limit')
  path.parent.mkdir(parents=True, exist_ok=True)
  with tar.extractfile(entry) as src, path.open('xb') as dst:
   remaining = entry.size
   while remaining:
    block = src.read(min(remaining, 1024*1024))
    if not block: raise ValueError('truncated member')
    dst.write(block); remaining -= len(block)
  os.chmod(path, 0o755 if entry.mode & 0o111 else 0o644)
`;
export async function downloadRelease(update: VerifiedUpdate, directory: string, signal: AbortSignal,
  dependencies: Dependencies = {}): Promise<{ payload: string; manifestSha256: string }> {
  need(update.asset.url === `${origin}${update.tag}/${update.asset.name}` && update.tag === `v${update.version}`
    && version(update.version) && ['linux-arm64', 'linux-amd64'].includes(update.platform)
    && update.asset.name === `cocoproxy-${update.version}-${update.platform}.tar.gz`
    && Number.isSafeInteger(update.asset.size) && update.asset.size > 0 && update.asset.size <= 256 * 1024 * 1024
    && sha(update.asset.sha256) && sha(update.manifestSha256), 'UPDATE_PACKAGE_INVALID');
  const destination = resolve(directory); await mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = join(destination, 'download.tar.gz'), extracted = join(destination, 'extracted');
  await mkdir(extracted, { mode: 0o700 });
  try {
    const file = await open(archive, 'wx', 0o600);
    let downloaded = 0; const digest = createHash('sha256');
    try {
      await request(update.asset.url, update.asset.size, signal, dependencies.fetch ?? fetch, async chunk => {
        downloaded += chunk.byteLength; digest.update(chunk); await file.writeFile(chunk);
      });
    } finally { await file.close(); }
    need(downloaded === update.asset.size && digest.digest('hex') === update.asset.sha256, 'UPDATE_PACKAGE_HASH_MISMATCH');
    await new Promise<void>((accept, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-B', '-c', extractor, archive, extracted, update.asset.name.slice(0, -7)],
        { stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: 120_000 });
      let failure: Error | undefined;
      child.stderr.resume(); child.once('error', error => { failure = error; });
      // Wait for process closure before removing files after cancellation.
      child.once('close', code => failure ? reject(failure) : code === 0 ? accept() : reject(new Error('UPDATE_EXTRACTION_FAILED')));
    });
    const payload = join(extracted, update.asset.name.slice(0, -7));
    const { verifyRelease } = await import('../deployment/install.ts');
    await verifyRelease(payload, update.manifestSha256);
    const manifest = JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8'));
    need(manifest.commit === update.commit && manifest.components?.cocoproxy?.version === update.version
      && manifest.components?.mihomo?.platform === (update.platform === 'linux-amd64' ? 'linux-amd64-v1' : update.platform), 'UPDATE_MANIFEST_IDENTITY_MISMATCH');
    return { payload, manifestSha256: update.manifestSha256 };
  } catch (error) { await rm(extracted, { recursive: true, force: true }); throw error; }
  finally { await rm(archive, { force: true }); }
}
