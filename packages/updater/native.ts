import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, rm, statfs } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, privateRead } from '../storage/private-files.ts';
import { assertRootControlledPath, assertTrustedExecutable } from '../deployment/path-evidence.ts';
import type { PathEvidenceHost } from '../deployment/path-evidence.ts';
import { validateReceipt, verifyRelease } from '../deployment/install.ts';
import { findRelease, downloadRelease } from './release.ts';
import type { Platform, VerifiedUpdate } from './release.ts';
import type { InstalledUpdate, UpdaterHost, UpdateState } from './engine.ts';
import { initialUpdateState, parseUpdateState } from './engine.ts';
import { UpdateError } from './types.ts';

export const UPDATER_STATE_DIRECTORY = '/var/lib/cocoproxy-updater';
export const UPDATER_RUNTIME_DIRECTORY = '/run/cocoproxy-updater';
const RECEIPT = '/var/lib/cocoproxy-deployment/receipt.json';
const DEPLOYMENT = '/etc/cocoproxy-install/deployment.json';
const JOURNAL = '/etc/cocoproxy-install/remote-last.json';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const need = (condition: unknown, code: string): void => { if (!condition) throw new UpdateError(code, 503); };

export interface UpdaterSettings { schemaVersion: 1; serviceUid: number; nodePath: string; sourceDirectory: string; releaseDirectory: string }
const evidence: PathEvidenceHost = { resolve: realpath, info: async path => {
  try { const s = await lstat(path); return { directory: s.isDirectory(), file: s.isFile(), link: s.isSymbolicLink(),
    uid: s.uid, mode: s.mode, nlink: s.nlink, identity: `${s.dev}:${s.ino}:${s.ctimeMs}` }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
} };

/** Only root-controlled single-link regular files can select executable code or trust roots. */
export async function trustedRead(path: string, limit = 4 * 1024 * 1024): Promise<Buffer> {
  // A missing leaf must retain ENOENT for optional first-start files. Existing
  // leaves and every ancestor still require the same ownership checks.
  await assertRootControlledPath(path, evidence, true);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    need(before.isFile() && before.nlink === 1 && before.uid === 0 && !(before.mode & 0o022) && before.size <= limit, 'UPDATER_UNTRUSTED_FILE');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    const after = await file.stat();
    need(length <= limit && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'UPDATER_UNTRUSTED_FILE');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
const trustedJSON = async (path: string, limit?: number): Promise<any> => JSON.parse((await trustedRead(path, limit)).toString('utf8'));
export async function loadUpdaterSettings(path: string): Promise<UpdaterSettings> {
  const input = await trustedJSON(path, 8192);
  need(input && Object.keys(input).sort().join(',') === 'nodePath,releaseDirectory,schemaVersion,serviceUid,sourceDirectory'
    && input.schemaVersion === 1 && Number.isSafeInteger(input.serviceUid) && input.serviceUid > 0 && input.serviceUid <= 2 ** 31 - 1,
  'UPDATER_EXECUTION_SETTINGS_INVALID');
  for (const key of ['nodePath', 'releaseDirectory', 'sourceDirectory']) need(typeof input[key] === 'string' && input[key].startsWith('/')
    && posix.normalize(input[key]) === input[key] && !/[\x00-\x20\x7f]/.test(input[key]), 'UPDATER_EXECUTION_SETTINGS_INVALID');
  need(input.sourceDirectory === input.releaseDirectory + '/source' && /^[a-f0-9]{64}$/.test(posix.basename(input.releaseDirectory)), 'UPDATER_EXECUTION_SETTINGS_INVALID');
  await assertTrustedExecutable(input.nodePath, evidence);
  await assertTrustedExecutable('/usr/bin/python3', evidence);
  await assertRootControlledPath(input.sourceDirectory + '/apps/updater/main.ts', evidence);
  return input as UpdaterSettings;
}
export async function loadUpdateState(): Promise<UpdateState> {
  try { return parseUpdateState(JSON.parse(await privateRead(join(UPDATER_STATE_DIRECTORY, 'state.json'), 64 * 1024))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialUpdateState(); throw error; }
}

/** All subprocess output remains private; callers receive only fixed result codes. */
export async function runUpdaterTool(command: string, args: string[], options: { signal?: AbortSignal; timeout?: number } = {}): Promise<{ code: number; stdout: Buffer }> {
  await assertTrustedExecutable(command, evidence);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' }, signal: options.signal });
    const chunks: Buffer[] = []; let size = 0, exceeded = false;
    let failure: Error | null = null;
    const timer = options.timeout ? setTimeout(() => { exceeded = true; child.kill('SIGTERM'); }, options.timeout) : undefined;
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); }
      else chunks.push(bytes);
    });
    // Native diagnostics may contain operational details; never relay them to the UI or journal summary.
    child.stderr.on('data', () => {});
    child.once('error', error => { failure = error; });
    child.once('close', code => { clearTimeout(timer); failure ? reject(failure) : exceeded ? reject(new UpdateError('UPDATER_TOOL_LIMIT', 503))
      : resolveRun({ code: code ?? -1, stdout: Buffer.concat(chunks) }); });
  });
}

/** A manual deployment must settle before an idle daemon follows its new execution settings. */
export async function updaterRefreshReady(settings: UpdaterSettings): Promise<boolean> {
  try {
    const receipt = validateReceipt(await trustedJSON(RECEIPT, 128 * 1024));
    const journal = await trustedJSON(JOURNAL, 512 * 1024);
    return receipt.status === 'complete' && receipt.release === settings.releaseDirectory && ['complete', 'recovered'].includes(journal.status);
  } catch { return false; }
}

/** Explicit root-only acknowledgement after the existing inspect/recover procedure, with the daemon stopped. */
export async function acknowledgeUpdateRecovery(settings: UpdaterSettings, expectedManifest: string): Promise<void> {
  need(/^[a-f0-9]{64}$/.test(expectedManifest), 'UPDATER_RECOVERY_INVALID');
  try { await lstat(join(UPDATER_RUNTIME_DIRECTORY, 'owner.json')); throw new UpdateError('UPDATER_BUSY', 409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const receipt = validateReceipt(await trustedJSON(RECEIPT, 128 * 1024));
  const journal = await trustedJSON(JOURNAL, 512 * 1024);
  need(receipt.status === 'complete' && receipt.manifestSha256 === expectedManifest && ['complete', 'recovered'].includes(journal.status), 'UPDATER_REVIEW_REQUIRED');
  const inspected = await runUpdaterTool(settings.nodePath, ['--experimental-strip-types', settings.sourceDirectory + '/apps/deployment/main.ts', '--operation', 'inspect']);
  need(inspected.code === 0, 'UPDATER_REVIEW_REQUIRED');
  const report = JSON.parse(inspected.stdout.toString('utf8'));
  need(report.installed === true && report.release === 'matches-receipt' && report.receipt?.status === 'complete'
    && report.receipt?.manifestSha256 === expectedManifest && report.lock?.present === false
    && Array.isArray(report.files) && report.files.every((item: any) => item.status === 'matches-receipt'), 'UPDATER_REVIEW_REQUIRED');
  const state = await loadUpdateState();
  need(state.needsReview, 'UPDATER_RECOVERY_INVALID');
  state.needsReview = false; state.scheduledAt = null; state.lastResult = 'recovered';
  if (state.job) { state.job.phase = 'failed'; state.job.error = null; }
  await atomicWrite(UPDATER_STATE_DIRECTORY, 'state.json', JSON.stringify(state) + '\n');
}

export function createNativeUpdaterHost(settings: UpdaterSettings): UpdaterHost {
  const platform: Platform | null = process.arch === 'arm64' ? 'linux-arm64' : process.arch === 'x64' ? 'linux-amd64' : null;
  async function installed() {
    const receipt = validateReceipt(await trustedJSON(RECEIPT, 128 * 1024));
    need(receipt.status === 'complete', 'UPDATER_INSTALLATION_INVALID');
    const bytes = await trustedRead(receipt.release + '/manifest.json');
    need(sha(bytes) === receipt.manifestSha256, 'UPDATER_INSTALLATION_INVALID');
    const manifest = JSON.parse(bytes.toString('utf8'));
    const version = manifest.components?.cocoproxy?.version;
    need(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'UPDATER_CURRENT_VERSION_INVALID');
    return { version, manifestSha256: receipt.manifestSha256, receipt, manifest };
  }
  async function stable(original: InstalledUpdate) {
    const current = await installed();
    need(current.manifestSha256 === original.manifestSha256, 'UPDATER_INSTALLATION_CHANGED');
    return current;
  }
  async function coordinator(payload: string, update: VerifiedUpdate, original: InstalledUpdate, preview: boolean, signal?: AbortSignal) {
    return runUpdaterTool('/usr/bin/python3', [payload + '/source/scripts/remote-deploy.py', '--payload', payload,
      '--manifest-sha256', update.manifestSha256, '--expected-manifest-sha256', original.manifestSha256,
      ...(preview ? ['--preview'] : [])], { signal, ...(preview ? { timeout: 300_000 } : {}) });
  }
  return {
    now: Date.now,
    save: state => atomicWrite(UPDATER_STATE_DIRECTORY, 'state.json', JSON.stringify(state) + '\n'),
    installed,
    configured: async () => platform !== null,
    find: async (currentVersion, signal) => {
      need(platform, 'UPDATER_PLATFORM_UNSUPPORTED');
      return findRelease(currentVersion, platform!, signal);
    },
    download: async (update, id, signal) => {
      const scratch = join(UPDATER_STATE_DIRECTORY, 'download-' + id);
      const storage = await statfs(UPDATER_STATE_DIRECTORY, { bigint: true });
      // Space for archive, extraction, incoming copy and installed immutable release, with headroom.
      need(storage.bavail * storage.bsize >= BigInt(update.asset.size) + 3n * 512n * 1024n * 1024n + 64n * 1024n * 1024n, 'UPDATER_DISK_SPACE');
      await mkdir(scratch, { mode: 0o700 });
      const downloaded = await downloadRelease(update, scratch, signal);
      return downloaded.payload;
    },
    prepare: async (payload, update, original, signal) => {
      const current = await stable(original);
      // The first release supports only matching reader/writer contracts. Irreversible migrations require manual deployment.
      const next = await verifyRelease(payload, update.manifestSha256);
      need(isDeepStrictEqual(current.manifest.compatibility, next.compatibility), 'UPDATER_MANUAL_MIGRATION_REQUIRED');
      const input = await trustedJSON(DEPLOYMENT, 128 * 1024);
      need(input.runtime?.nodePath === settings.nodePath, 'UPDATER_EXECUTION_SETTINGS_INVALID');
      const preview = await coordinator(payload, update, original, true, signal);
      need(preview.code === 0, 'UPDATER_PREFLIGHT_FAILED');
      await stable(original);
    },
    apply: async (payload, update, original) => {
      await stable(original);
      const result = await coordinator(payload, update, original, false);
      if (result.code === 0) {
        const current = await installed();
        need(current.manifestSha256 === update.manifestSha256 && current.version === update.version, 'UPDATER_VERSION_NOT_RUNNING');
        const journal = await trustedJSON(JOURNAL, 512 * 1024);
        need(journal.status === 'complete', 'UPDATER_POSTCHECK_FAILED');
        return 'updated';
      }
      const journal = await trustedJSON(JOURNAL, 512 * 1024).catch(() => null);
      const current = await installed().catch(() => null);
      if (journal?.status === 'recovered' && current?.manifestSha256 === original.manifestSha256) return 'recovered';
      return 'manual-review-required';
    },
    cleanup: id => rm(join(UPDATER_STATE_DIRECTORY, 'download-' + id), { recursive: true, force: true }),
  };
}
