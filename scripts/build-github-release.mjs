#!/usr/bin/env node
// Runs in an ephemeral GitHub-hosted Linux runner; never reads local lab data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stageExplicitRelease } from './stage-explicit-release.mjs';
import { validateReleaseMetadata, validateReleaseTooling, validateReleaseVersion } from './release-metadata.mjs';
import { assertReleaseSourcePaths, releaseAssetPlatform } from './release-layout.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const source = await realpath(process.cwd());
const pkg = await json(join(source, 'package.json'));
const lock = await json(join(source, 'package-lock.json'));
const catalog = validateReleaseMetadata(await json(join(source, 'integrations/metacubexd/components.json')),
  await json(join(source, 'integrations/metacubexd/review.json')), await json(join(source, 'integrations/metacubexd/source-tree.json')));
validateReleaseTooling(catalog, await json(join(source, 'tooling/package.json')), await json(join(source, 'tooling/package-lock.json')));
const tag = process.env.GITHUB_REF_NAME;
// Accept SemVer release/prerelease tags only, and require exact package agreement.
assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'A tag push is required');
validateReleaseVersion(pkg, lock, tag);
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u, 'Release commit is required');
run('git', ['diff', '--exit-code', process.env.GITHUB_SHA, 'HEAD']);
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
assert.equal(head.status, 0);
assert.equal(head.stdout.trim(), process.env.GITHUB_SHA, 'Checkout must match triggering commit');
const tracked = spawnSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], { encoding: 'utf8', windowsHide: true });
assert.equal(tracked.status, 0, 'Cannot inspect release source tree');
const sourceEntries = tracked.stdout.split('\0').filter(Boolean).map(line => {
  const entry = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/u.exec(line);
  assert.ok(entry, 'Release source cannot contain links or submodules');
  return entry[2];
});
assertReleaseSourcePaths(sourceEntries);
if (process.argv.length === 3 && process.argv[2] === '--validate') {
  console.log(`Validated ${tag} at ${process.env.GITHUB_SHA}`);
} else {
  assert.equal(process.argv.length, 2, 'Only --validate is supported');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Build only in GitHub Actions');
  assert.equal(process.platform, 'linux', 'Linux build runner is required');
  assert.ok(process.env.RUNNER_TEMP, 'Runner temporary directory is required');
  const work = join(await realpath(process.env.RUNNER_TEMP), 'cocoproxy-release');
  // Refuse reuse: neither old payloads nor partial assets can enter a new release.
  await mkdir(work);
  const assets = join(work, 'assets');
  const upstream = join(work, 'metacubexd');
  await mkdir(assets);
  await mkdir(upstream);
  const management = catalog.management;
  const core = catalog.mihomo;
  const download = async (url, destination, expectedHash) => {
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--proto', '=https', '--proto-redir', '=https', '--output', destination, url]);
    if (expectedHash) assert.equal(await sha256(destination), expectedHash, 'Downloaded archive hash mismatch');
  };

  console.log('::group::Verify fixed upstream sources');
  const managementArchive = join(assets, `metacubexd-${management.tag}-source.tar.gz`);
  await download(`https://codeload.github.com/MetaCubeX/metacubexd/tar.gz/${management.commit}`,
    managementArchive, management.sourceArchiveSha256);
  run('tar', ['-xzf', managementArchive, '--strip-components=1', '-C', upstream]);
  run(process.execPath, ['scripts/verify-git-tree.mjs', '--directory', upstream,
    '--manifest', join(source, 'integrations/metacubexd/source-tree.json')]);
  const upstreamLock = join(upstream, 'pnpm-lock.yaml');
  assert.equal(await sha256(upstreamLock), management.lockfileSha256);
  const coreArchive = join(assets, `mihomo-${core.tag}-source.tar.gz`);
  await download(`https://codeload.github.com/MetaCubeX/mihomo/tar.gz/${core.commit}`, coreArchive);
  run('git', ['archive', '--format=tar.gz', `--prefix=cocoproxy-${pkg.version}/`,
    `--output=${join(assets, `cocoproxy-${pkg.version}-source.tar.gz`)}`, 'HEAD']);
  console.log('::endgroup::');

  console.log('::group::Build reviewed management UI and server');
  const pnpm = (...args) => run(process.execPath, [join(source, 'tooling/node_modules/pnpm/bin/pnpm.cjs'), '--dir', upstream, ...args], {
    env: { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1', COCOPROXY_SOURCE_DIR: source },
  });
  pnpm('--filter', '@metacubexd/server...', '--filter', '@metacubexd/ui...',
    'install', '--frozen-lockfile', '--ignore-scripts');
  run(process.execPath, ['scripts/apply-metacubexd-overlay.mjs', '--directory', upstream]);
  pnpm('--filter', '@metacubexd/ui', 'generate');
  run(process.execPath, ['scripts/typecheck-metacubexd-ui.mjs', '--directory', upstream]);
  pnpm('--filter', '@metacubexd/server', 'build');
  assert.equal(await sha256(upstreamLock), management.lockfileSha256, 'Upstream lockfile changed');
  console.log('::endgroup::');

  for (const platform of ['linux-arm64', 'linux-amd64-v1']) {
    console.log(`::group::Assemble ${platform}`);
    const entry = core.platforms[platform];
    const compressed = join(work, `${platform}.gz`);
    const binary = join(work, `${platform}.mihomo`);
    await download(entry.downloadUrl, compressed, entry.releaseReportedSha256);
    run('gzip', ['--decompress', '--keep', compressed]);
    // gzip removes only the .gz suffix.
    await copyFile(join(work, platform), binary);
    assert.equal(await sha256(binary), entry.binarySha256, 'Mihomo binary hash mismatch');
    const name = `cocoproxy-${pkg.version}-${releaseAssetPlatform(platform)}`;
    const output = join(work, name);
    const receipt = await stageExplicitRelease({ sourceDir: source,
      serverDir: join(upstream, 'apps/server/.output'), runtimeDependencies: join(source, 'node_modules'),
      core: binary, output });
    assert.equal(receipt.commit, process.env.GITHUB_SHA);
    const manifest = join(output, 'manifest.json');
    assert.equal(await sha256(manifest), receipt.manifestSha256);
    await copyFile(manifest, join(assets, `${name}.manifest.json`));
    run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner',
      '--exclude=.local', '--exclude=*/.local', '-czf', join(assets, `${name}.tar.gz`), '-C', work, name]);
    console.log(JSON.stringify({ platform, ...receipt }));
    console.log('::endgroup::');
  }
  const sources = [
    `CoCoProxy ${tag}: commit ${process.env.GITHUB_SHA}; source archive includes all integration overlays and build scripts.`,
    `MetaCubeXD: ${management.repository}, ${management.tag}, commit ${management.commit}; MIT.`,
    `Mihomo: ${core.repository}, ${core.tag}, commit ${core.commit}; GPL-3.0. The distributed core is unmodified.`,
    'Upstream source archives include build files and dependency locks. See their licenses and build instructions.',
    'CoCoProxy runtime dependency licenses are retained in both Linux payloads.',
    'Build recipe: .github/workflows/release.yml, scripts/build-github-release.mjs and integrations/metacubexd/README.md in the CoCoProxy source archive.',
  ];
  await writeFile(join(assets, 'SOURCES.txt'), `${sources.join('\n')}\n`);
  await copyFile(join(source, 'docs/release-notes.md'), join(assets, 'RELEASE-NOTES.md'));
  const checksums = [];
  for (const name of (await readdir(assets)).sort()) checksums.push(`${await sha256(join(assets, name))}  ${name}`);
  await writeFile(join(assets, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  run('sha256sum', ['--check', 'SHA256SUMS'], { cwd: assets });
  console.log(`Release assets ready: ${tag}`);
}
