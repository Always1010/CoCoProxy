import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyBuiltRelease } from './build-release.mjs';

export const localFail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
export const within = (parent, child) => { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export async function canonicalLocalPath(value, directory = true) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value === parse(value).root) localFail('LOCAL_PATH_INVALID');
  let current = parse(value).root;
  for (const part of relative(current, value).split(sep)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current !== value && !info.isDirectory())) localFail('LOCAL_PATH_LINK');
  }
  const info = await lstat(value);
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) localFail('LOCAL_PATH_TYPE');
  if (await realpath(value) !== value) localFail('LOCAL_PATH_LINK');
  return value;
}
export async function readLocalJSON(filename) {
  await canonicalLocalPath(filename, false);
  const info = await lstat(filename);
  if (info.size > 8 * 1024 * 1024) localFail('LOCAL_STATE_TOO_LARGE');
  return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
}
export async function writeLocalJSON(filename, value) {
  await canonicalLocalPath(dirname(filename));
  try { await canonicalLocalPath(filename, false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = filename + '.' + randomUUID();
  const fd = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, filename);
}
export async function resolveLocalPaths(source, workspace, { create = true } = {}) {
  source = await canonicalLocalPath(resolve(source));
  workspace = resolve(workspace ?? join(dirname(source), basename(source) + '-build'));
  if (source === workspace || within(source, workspace) || within(workspace, source)) localFail('LOCAL_WORKSPACE_OVERLAP');
  await canonicalLocalPath(dirname(workspace));
  if (!create) {
    try { await canonicalLocalPath(workspace); } catch (error) {
      if (error.code === 'ENOENT') localFail('LOCAL_BUILD_REQUIRED', '尚无成功构建，请先运行 bash scripts/build-release.sh。');
      throw error;
    }
    const identity = await readLocalJSON(join(workspace, '.cocoproxy-build.json'));
    if (identity.schemaVersion !== 1 || identity.source !== source) localFail('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
    return { source, workspace, receipt: join(workspace, 'build-result.json'), lock: join(workspace, '.workspace-sync.lock') };
  }
  try { await mkdir(workspace, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await canonicalLocalPath(workspace);
  const marker = join(workspace, '.cocoproxy-build.json');
  try { await lstat(marker); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(workspace)).length) localFail('LOCAL_WORKSPACE_NOT_EMPTY', '构建目录已有不属于本入口的内容，请使用 --workspace 指定空目录。');
  }
  try {
    const fd = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await fd.writeFile(JSON.stringify({ schemaVersion: 1, source }) + '\n'); } finally { await fd.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identity = await readLocalJSON(marker);
  if (identity.schemaVersion !== 1 || identity.source !== source) localFail('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
  return { source, workspace, receipt: join(workspace, 'build-result.json'), lock: join(workspace, '.workspace-sync.lock') };
}

/** Never uses a shell. Abort kills only this command's process group on Linux. */
export function runLocalCommand(command, args, options = {}) {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true,
      detached: process.platform === 'linux', stdio: [options.input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 2, 'inherit'] });
    const chunks = []; let size = 0; let error;
    const stop = reason => {
      error = reason;
      if (child.pid) { try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {} }
    };
    const abort = () => stop(options.signal.reason ?? new Error('LOCAL_COMMAND_ABORTED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) stop(new Error('LOCAL_COMMAND_OUTPUT_TOO_LARGE')); else chunks.push(chunk); });
    child.once('error', cause => { error = cause; });
    child.once('close', code => {
      options.signal?.removeEventListener('abort', abort);
      if (error || code !== 0) reject(error ?? Object.assign(new Error(`${command} 执行失败，请查看上方输出。`), { code: 'LOCAL_COMMAND_FAILED' }));
      else accept(options.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'));
    });
    if (options.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
  });
}

export async function withLocalBuildLock(paths, action) {
  await canonicalLocalPath(paths.workspace);
  const code = 'import fcntl,os,stat,sys;fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);assert stat.S_ISREG(os.fstat(fd).st_mode);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);print("LOCKED",flush=True);sys.stdin.read()';
  const holder = spawn('python3', ['-u', '-c', code, paths.lock], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const controller = new AbortController(); let released = false; let exited = false;
  const cancel = () => controller.abort(Object.assign(new Error('操作已取消。'), { code: 'LOCAL_OPERATION_CANCELLED' }));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const lost = () => { exited = true; if (!released) controller.abort(Object.assign(new Error('构建目录被占用，或工作区锁连接已中断。'), { code: 'LOCAL_BUILD_LOCK_LOST' })); };
  holder.once('error', lost); holder.once('exit', lost); holder.stdin.on('error', () => {});
  holder.stderr.resume();
  try {
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('LOCAL_BUILD_LOCK_TIMEOUT')), 10000);
      const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
      controller.signal.addEventListener('abort', abort, { once: true });
      holder.stdout.once('data', data => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
        if (data.toString().trim() !== 'LOCKED') reject(new Error('LOCAL_BUILD_LOCK_INVALID')); else accept();
      });
      if (controller.signal.aborted) abort();
    });
    const assertHeld = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    const result = await action({ signal: controller.signal, assertHeld });
    assertHeld(); return result;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    released = true;
    if (!exited) {
      await new Promise(accept => { holder.once('close', accept); holder.stdin.end(); });
    }
  }
}

export async function cleanLocalCommit(source, execute = runLocalCommand) {
  // sudo deployment reads the invoking developer's checkout. Trust this exact
  // explicitly selected root for this command only, never edit global Git config.
  const git = args => execute('git', ['-c', `safe.directory=${source}`, '-c', 'core.hooksPath=/dev/null', '-C', source, ...args], { capture: true });
  if (resolve((await git(['rev-parse', '--show-toplevel'])).trim()) !== source) localFail('LOCAL_SOURCE_ROOT_REQUIRED');
  if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).length) localFail('LOCAL_SOURCE_DIRTY', '请先审查并提交源码，然后重新构建。');
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) localFail('LOCAL_COMMIT_INVALID');
  return commit;
}
export async function readLocalBuild({ source, workspace }) {
  const paths = await resolveLocalPaths(source, workspace, { create: false });
  let receipt;
  try { receipt = await readLocalJSON(paths.receipt); } catch (error) {
    if (error.code === 'ENOENT') localFail('LOCAL_BUILD_REQUIRED', '尚无成功构建，请先运行 bash scripts/build-release.sh。');
    throw error;
  }
  if (receipt.schemaVersion !== 1 || receipt.status !== 'ready' || receipt.source !== paths.source) localFail('LOCAL_BUILD_NOT_READY', '本轮构建尚未成功，不能部署以前的包。');
  if (await cleanLocalCommit(paths.source) !== receipt.commit) localFail('LOCAL_BUILD_COMMIT_CHANGED', '源码提交已改变，请重新构建。');
  if (!within(join(paths.workspace, 'releases'), receipt.output)) localFail('LOCAL_RELEASE_SCOPE');
  const verified = await verifyBuiltRelease(receipt.output, receipt, receipt.commit);
  return { ...receipt, components: verified.components };
}
