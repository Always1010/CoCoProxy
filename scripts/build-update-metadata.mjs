#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildUpdateMetadata({ directory, version, tag, commit, automatic = true }) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(tag, `v${version}`);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const platforms = {};
  for (const platform of ['linux-arm64', 'linux-amd64']) {
    const name = `cocoproxy-${version}-${platform}.tar.gz`;
    const manifestBytes = await readFile(join(directory, `cocoproxy-${version}-${platform}.manifest.json`));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.components?.cocoproxy?.version, version);
    assert.equal(manifest.components?.mihomo?.platform, platform === 'linux-amd64' ? 'linux-amd64-v1' : platform);
    const archivePath = join(directory, name);
    assert.equal((await stat(archivePath)).isFile(), true);
    const bytes = await readFile(archivePath);
    assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024 * 1024);
    platforms[platform] = { name, url: `https://github.com/Always1010/CoCoProxy/releases/download/${tag}/${name}`,
      size: bytes.length, sha256: sha256(bytes), manifestSha256: sha256(manifestBytes) };
  }
  const metadata = { schemaVersion: 1, repository: 'Always1010/CoCoProxy', version, tag, commit,
    minimumNode: '22.18.0', minimumUpdater: 1, automatic, platforms };
  const bytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(directory, 'update.json'), bytes, { flag: 'wx' });
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/build-update-metadata.mjs ASSET_DIRECTORY');
  await buildUpdateMetadata({ directory: resolve(process.argv[2]), version: process.env.GITHUB_REF_NAME?.replace(/^v/u, ''),
    tag: process.env.GITHUB_REF_NAME, commit: process.env.GITHUB_SHA });
}
