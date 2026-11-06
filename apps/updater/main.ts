import { createServer } from 'node:http';
import { chown, chmod, lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { UpdateEngine } from '../../packages/updater/engine.ts';
import { createNativeUpdaterHost, loadUpdaterSettings, loadUpdateState, UPDATER_RUNTIME_DIRECTORY,
  UPDATER_STATE_DIRECTORY, trustedRead, updaterRefreshReady, acknowledgeUpdateRecovery } from '../../packages/updater/native.ts';
import { UpdateError } from '../../packages/updater/types.ts';
import type { UpdateCommand } from '../../packages/updater/types.ts';
import { readJsonBody, exactRecord } from '../../packages/management/http.ts';

/** Independent service. No management-server lifecycle or browser connection owns its task. */
export async function main(args: string[]): Promise<void> {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || ![2, 4].includes(args.length) || args[0] !== '--settings'
    || !args[1].startsWith('/') || resolve(args[1]) !== args[1]) throw new UpdateError('UPDATER_ARGUMENTS_INVALID');
  process.umask(0o077);
  const settingsPath = args[1];
  const settings = await loadUpdaterSettings(settingsPath);
  if (args.length === 4) {
    if (args[2] !== '--acknowledge-recovery') throw new UpdateError('UPDATER_ARGUMENTS_INVALID');
    await acknowledgeUpdateRecovery(settings, args[3]);
    console.log(JSON.stringify({ acknowledged: true })); return;
  }
  for (const [path, mode] of [[UPDATER_STATE_DIRECTORY, 0o700], [UPDATER_RUNTIME_DIRECTORY, 0o755]] as const) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o7777) !== mode) throw new UpdateError('UPDATER_DIRECTORY_UNSAFE', 503);
  }
  // A filesystem lock binds PID to its live proc identity. Never clear an unknown deployment or updater owner.
  const lockPath = join(UPDATER_RUNTIME_DIRECTORY, 'owner.json');
  const startTime = (pid: number) => trustedProc(pid);
  const identity = { pid: process.pid, startTime: await startTime(process.pid) };
  try {
    const prior = await trustedRead(lockPath, 1024).then(bytes => JSON.parse(bytes.toString('utf8'))).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    });
    if (prior) {
      if (!Number.isSafeInteger(prior.pid) || typeof prior.startTime !== 'string') throw new UpdateError('UPDATER_OWNER_INVALID', 503);
      let live: string | null;
      try { live = await startTime(prior.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; live = null; }
      if (live === prior.startTime) throw new UpdateError('UPDATER_BUSY', 409);
      await unlink(lockPath);
    }
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await lock.writeFile(JSON.stringify(identity)); await lock.sync(); } finally { await lock.close(); }
  } catch { throw new UpdateError('UPDATER_BUSY', 409); }
  let engine: UpdateEngine;
  try { engine = new UpdateEngine(createNativeUpdaterHost(settings), await loadUpdateState()); }
  catch (error) { await unlink(lockPath); throw error; }
  const socketPath = join(UPDATER_RUNTIME_DIRECTORY, 'control.sock');
  let ready = false;
  const server = createServer(async (request, response) => {
    try {
      if (!ready) throw new UpdateError('UPDATER_UNAVAILABLE', 503);
      if (request.method !== 'POST' || request.url !== '/') throw new UpdateError('UPDATER_REQUEST_INVALID');
      const abort = new AbortController();
      request.once('aborted', () => abort.abort());
      const body = await readJsonBody(new Request('http://localhost/', { method: 'POST', headers: request.headers as Record<string, string>,
        body: (await import('node:stream')).Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: 'half', signal: abort.signal } as RequestInit), 8192);
      const action = (body as { action?: unknown })?.action;
      exactRecord(body, action === 'configure' ? ['action', 'expectedRevision', 'settings'] : action === 'install' ? ['action', 'expectedVersion'] : ['action']);
      if (!['status', 'configure', 'check', 'install'].includes(action as string)) throw new UpdateError('UPDATER_REQUEST_INVALID');
      const value = await engine.handle(body as UpdateCommand);
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : 'UPDATER_REQUEST_FAILED';
      response.writeHead(error instanceof UpdateError ? error.status : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: code }));
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.maxConnections = 16;
  let closing = false, ticking = false;
  const finish = async (restart: boolean) => {
    if (closing) return; closing = true;
    clearInterval(timer);
    await engine.close();
    await new Promise<void>(accept => { server.close(() => accept()); server.closeIdleConnections(); });
    await unlink(socketPath).catch(() => {}); await unlink(lockPath);
    if (restart) {
      const next = await loadUpdaterSettings(settingsPath);
      process.execve!(next.nodePath, [next.nodePath, '--experimental-strip-types', next.sourceDirectory + '/apps/updater/main.ts', '--settings', settingsPath],
        { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' });
    }
  };
  const tick = async () => {
    if (closing || ticking) return; ticking = true;
    try {
      const next = await loadUpdaterSettings(settingsPath);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        engine.cancelAutomaticPreparation();
        if (!engine.busy && await updaterRefreshReady(next)) await finish(true);
        return;
      }
      await engine.tick();
    } catch { console.error('UPDATER_BACKGROUND_UNAVAILABLE'); }
    finally { ticking = false; }
  };
  const timer = setInterval(() => { void tick(); }, 15_000);
  try {
    await engine.initialize();
    try {
      const previous = await lstat(socketPath);
      if (!previous.isSocket() || previous.uid !== settings.serviceUid) throw new UpdateError('UPDATER_SOCKET_UNSAFE', 503);
      await unlink(socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); accept(); }); });
    await chown(socketPath, settings.serviceUid, -1); await chmod(socketPath, 0o600);
    // Before readiness there are no tasks to drain; default signal handling exits startup safely.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { ready = false; void finish(false).catch(() => { process.exitCode = 1; }); });
    ready = true;
    await tick();
  } catch (error) { clearInterval(timer); await engine.close(); server.close(); await unlink(lockPath).catch(() => {}); throw error; }
}

async function trustedProc(pid: number): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = value.lastIndexOf(')');
  if (end < 0) throw new UpdateError('UPDATER_OWNER_INVALID', 503);
  const start = value.slice(end + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(start)) throw new UpdateError('UPDATER_OWNER_INVALID', 503);
  return start;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('UPDATER_START_FAILED'); process.exitCode = 1; });
}
