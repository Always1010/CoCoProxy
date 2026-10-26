#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const quoteRemote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function parseRemoteOptions(args) {
  const target = args[0];
  if (!isIP(target ?? '')) fail('REMOTE_TARGET_IP_REQUIRED');
  const result = { target, check: false, preview: false };
  const values = new Set(['--payload', '--manifest-sha256', '--user', '--port', '--identity', '--known-hosts', '--host-key-alias', '--environment', '--input', '--admin-input', '--router-config', '--router-hook', '--web-unit']);
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (['--check', '--preview'].includes(option)) { result[option.slice(2)] = true; continue; }
    if (!values.has(option) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(result, option)) fail('REMOTE_ARGUMENTS_INVALID');
    result[option] = args[++index];
  }
  if (result['--user'] && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(result['--user'])) fail('REMOTE_SSH_USER_INVALID');
  if (result['--port'] && (!/^\d{1,5}$/.test(result['--port']) || Number(result['--port']) < 1 || Number(result['--port']) > 65535)) fail('REMOTE_SSH_PORT_INVALID');
  if (result['--manifest-sha256'] && !/^[a-f0-9]{64}$/.test(result['--manifest-sha256'])) fail('REMOTE_MANIFEST_SHA_INVALID');
  return result;
}
export function payloadPath(path) {
  if (typeof path !== 'string' || path.length > 1024 || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path)
      || path.split('/').some(part => !part || ['.', '..', '.local', '.git'].includes(part.toLowerCase()))) fail('REMOTE_PAYLOAD_PATH_INVALID');
  return path;
}
function run(command, args, { input, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = []; let size = 0;
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(Buffer.concat(chunks).toString('utf8')) : reject(Object.assign(new Error('REMOTE_COMMAND_FAILED'), { code: 'REMOTE_COMMAND_FAILED' })));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
export async function verifyTransportPayload(directory, expected) {
  const root = await realpath(directory), info = await lstat(join(root, 'manifest.json'));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) fail('REMOTE_MANIFEST_INVALID');
  const raw = await readFile(join(root, 'manifest.json'));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (expected && expected !== sha256) fail('REMOTE_MANIFEST_MISMATCH');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 10_000) fail('REMOTE_MANIFEST_INVALID');
  const names = new Set(['manifest.json']);
  for (const entry of manifest.files) {
    const name = payloadPath(entry.path);
    if (names.has(name) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !['0644', '0755'].includes(entry.mode)) fail('REMOTE_MANIFEST_INVALID');
    names.add(name);
    let current = root;
    for (const part of name.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) fail('REMOTE_PAYLOAD_LINK');
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || stat.size > 256 * 1024 * 1024) fail('REMOTE_PAYLOAD_FILE_INVALID');
    if (createHash('sha256').update(await readFile(current)).digest('hex') !== entry.sha256) fail('REMOTE_PAYLOAD_FILE_CHANGED');
  }
  if (!names.has('source/scripts/remote-deploy.py')) fail('REMOTE_PAYLOAD_DEPLOY_ENTRY_MISSING');
  return { root, sha256, names: [...names], commit: manifest.commit };
}

export async function deployRemote(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log(`CoCoProxy 远程部署／更新\n\n  cocoproxy deploy <IP> [--user USER] [--port PORT]\n  cocoproxy deploy <IP> --check\n  cocoproxy deploy <IP> --preview\n\n在已核验的解压发行包中运行；仅传输该发行包清单中的文件。\n首次安装提供 --environment 私有环境JSON --admin-input 私有管理员JSON。\n首次接入既有安装提供 --input 原私有安装JSON；后续更新复用目标保存的输入。\n自动网关更新另需 --router-config 私有路由器SSH配置，或 --router-hook 可信适配器；后续复用。\n可选：--identity SSH密钥路径 --known-hosts 已核验主机文件 --web-unit 外部HTTPS单元名。\n源码调用另提供 --payload 发行目录 --manifest-sha256 可信摘要。\n不会构建源码、安装系统依赖、猜测拓扑、自动接受SSH指纹或修改本机SSH配置。`);
    return;
  }
  const options = parseRemoteOptions(args);
  const ssh = ['-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  for (const [flag, sshFlag] of [['--port', '-p'], ['--identity', '-i'], ['--known-hosts', '-o']]) {
    if (options[flag]) ssh.push(sshFlag, flag === '--known-hosts' ? 'UserKnownHostsFile=' + resolve(options[flag]) : options[flag]);
  }
  const destination = (options['--user'] ? options['--user'] + '@' : '') + options.target;
  if (options['--host-key-alias']) {
    if (!/^[a-z0-9._:-]+$/i.test(options['--host-key-alias'])) fail('REMOTE_HOST_KEY_ALIAS_INVALID');
    ssh.push('-o', 'HostKeyAlias=' + options['--host-key-alias']);
  }
  const inventory = JSON.parse(await run('ssh', [...ssh, destination,
    "python3 -c " + quoteRemote("import json,os,platform,shutil;print(json.dumps({'platform':platform.system(),'architecture':platform.machine(),'root':os.geteuid()==0,'node':bool(shutil.which('node')),'systemd':os.path.isdir('/run/systemd/system')}))")], { capture: true }));
  if (inventory.platform !== 'Linux' || !['aarch64', 'x86_64'].includes(inventory.architecture) || !inventory.node || !inventory.systemd) fail('REMOTE_TARGET_PREREQUISITES_MISSING');
  if (options.check) { console.log(JSON.stringify({ checked: true, readOnly: true, ...inventory })); return; }
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (options['--payload'] && !options['--manifest-sha256']) fail('REMOTE_TRUSTED_MANIFEST_REQUIRED');
  const payload = await verifyTransportPayload(options['--payload'] ? resolve(options['--payload']) : bundled, options['--manifest-sha256']);
  const stage = (await run('ssh', [...ssh, destination, 'umask 077; mktemp -d /var/tmp/cocoproxy-upload.XXXXXXXXXX'], { capture: true })).trim();
  if (!/^\/var\/tmp\/cocoproxy-upload\.[A-Za-z0-9]{10}$/.test(stage)) fail('REMOTE_STAGE_INVALID');
  try {
    const tar = spawn('tar', ['-C', payload.root, '--null', '-T', '-', '-cf', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const receiver = spawn('ssh', [...ssh, destination, 'tar -xf - -C ' + quoteRemote(stage)], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
    const done = child => new Promise((resolveDone, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolveDone() : reject(new Error('REMOTE_TRANSFER_FAILED'))); });
    const transfers = Promise.all([done(tar), done(receiver)]);
    tar.stdout.pipe(receiver.stdin); receiver.stdin.on('error', () => {});
    tar.stdin.end(payload.names.join('\0') + '\0');
    await transfers;
    const remoteArgs = [stage + '/source/scripts/remote-deploy.py', '--payload', stage, '--manifest-sha256', payload.sha256];
    for (const [flag, name] of [['--environment', 'environment.json'], ['--input', 'deployment.json'], ['--admin-input', 'administrator.json'], ['--router-config', 'router-ssh.json']]) {
      if (!options[flag]) continue;
      const local = await realpath(resolve(options[flag])), stat = await lstat(local);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('REMOTE_PRIVATE_INPUT_REQUIRED');
      const remote = stage + '/' + name;
      const writer = "import os,sys;fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);f=os.fdopen(fd,'wb');f.write(sys.stdin.buffer.read());f.close()";
      await run('ssh', [...ssh, destination, 'python3 -c ' + quoteRemote(writer) + ' ' + quoteRemote(remote)], { input: await readFile(local) });
      remoteArgs.push(flag, remote);
    }
    for (const flag of ['--router-hook', '--web-unit']) if (options[flag]) remoteArgs.push(flag, options[flag]);
    if (options.preview) remoteArgs.push('--preview');
    const prefix = inventory.root ? ['python3'] : ['sudo', ...(process.stdin.isTTY ? [] : ['-n']), 'python3'];
    console.log(JSON.stringify({ phase: options.preview ? 'preflight' : 'deploy', sourceCommit: payload.commit, manifestSha256: payload.sha256 }));
    await run('ssh', [...ssh, process.stdin.isTTY ? '-t' : '-T', destination, [...prefix, ...remoteArgs].map(quoteRemote).join(' ')]);
  } finally {
    const cleanup = "import os,shutil,sys;from pathlib import Path;p=Path(sys.argv[1]);assert str(p).startswith('/var/tmp/cocoproxy-upload.') and not p.is_symlink() and p.stat().st_uid==os.getuid();shutil.rmtree(p)";
    await run('ssh', [...ssh, destination, 'python3 -c ' + quoteRemote(cleanup) + ' ' + quoteRemote(stage)]).catch(() => console.error('REMOTE_UPLOAD_CLEANUP_UNCONFIRMED'));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployRemote(process.argv.slice(2)).catch(error => { console.error(error.code ?? 'REMOTE_DEPLOY_FAILED'); process.exitCode = 1; });
}
