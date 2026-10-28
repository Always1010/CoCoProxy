import { X509Certificate, createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import { cloneConfigJson } from '../config/index.ts';
import type { DeploymentFile, DeploymentPlan } from '../deployment/plan.ts';

export class ManagedWebError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ManagedWebError'; this.code = code; }
}
const fail = (code = 'SETUP_HTTPS_INVALID'): never => { throw new ManagedWebError(code); };
export interface ManagedWebSettings {
  schemaVersion: 1; nginxPath: string; certificatePath: string; privateKeyPath: string;
}
export interface ManagedWebInput {
  web: unknown; gatewayIPv4: string; origin: string; listenPort: number; serviceUid: number;
}
const configPath = '/etc/cocoproxy/web/nginx.conf';
const unitPath = '/etc/systemd/system/cocoproxy-web.service';
const tempNames = ['client', 'proxy', 'fastcgi', 'uwsgi', 'scgi'] as const;
const tempPath = (name: string) => '/var/lib/cocoproxy-web-' + name;
function safePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !/^\/[A-Za-z0-9_./-]+$/.test(value) ||
      posix.normalize(value) !== value || value.endsWith('/') || value.split('/').includes('.local') ||
      ['/home', '/root', '/tmp', '/var/tmp', '/run', '/proc', '/sys', '/dev'].some(root => value === root || value.startsWith(root + '/')) ||
      value.startsWith('/var/lib/cocoproxy-web')) fail();
  return value as string;
}
function settings(input: unknown): ManagedWebSettings {
  const value = cloneConfigJson(input) as Record<string, unknown>;
  if (!value || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).sort().join(',') !== 'certificatePath,nginxPath,privateKeyPath,schemaVersion') fail();
  const result: ManagedWebSettings = { schemaVersion: 1, nginxPath: safePath(value.nginxPath),
    certificatePath: safePath(value.certificatePath), privateKeyPath: safePath(value.privateKeyPath) };
  const paths = [result.nginxPath, result.certificatePath, result.privateKeyPath, configPath, unitPath];
  if (paths.some((path, i) => paths.slice(i + 1).some(other => path === other || path.startsWith(other + '/') || other.startsWith(path + '/')))) fail();
  return result;
}

/** Pure managed-file proposal. Existing certificate/key references are never copied. */
export function renderManagedWeb(input: ManagedWebInput) {
  const web = settings(input.web);
  if (isIP(input.gatewayIPv4) !== 4 || /^(?:0|127)\.|^169\.254\./.test(input.gatewayIPv4) ||
      Number(input.gatewayIPv4.split('.')[0]) >= 224 || !Number.isInteger(input.serviceUid) || input.serviceUid <= 0 || input.serviceUid > 4_294_967_294 ||
      !Number.isInteger(input.listenPort) || input.listenPort < 1024 || input.listenPort > 65535) fail();
  const url = new URL(input.origin);
  const hostname = url.hostname;
  const port = Number(url.port || 443);
  if (url.origin !== input.origin || url.protocol !== 'https:' || url.username || url.password || port < 1024 || port > 65535 ||
      port === input.listenPort || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) ||
      hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) fail();
  const authority = url.host;
  const content = [
    '# Generated CoCoProxy HTTPS entry; authentication stays in the loopback backend.',
    'worker_processes 1;', 'pid /run/cocoproxy-web/nginx.pid;', 'error_log stderr warn;',
    'events { worker_connections 256; }', 'http {', '    access_log off;', '    server_tokens off;',
    '    client_max_body_size 4m;',
    ...tempNames.map(name => `    ${name === 'client' ? 'client_body' : name}_temp_path ${tempPath(name)};`),
    "    map $http_upgrade $connection_upgrade { default upgrade; '' close; }", '    server {',
    `        listen ${input.gatewayIPv4}:${port} ssl;`, `        server_name ${hostname};`,
    `        ssl_certificate ${web.certificatePath};`, `        ssl_certificate_key ${web.privateKeyPath};`,
    '        ssl_protocols TLSv1.2 TLSv1.3;', `        error_page 497 =308 ${input.origin}$request_uri;`,
    `        if ($http_host != "${authority}") { return 421; }`, '        location / {',
    `            proxy_pass http://127.0.0.1:${input.listenPort};`, '            proxy_http_version 1.1;',
    `            proxy_set_header Host "${authority}";`, `            proxy_set_header X-Forwarded-Host "${authority}";`,
    '            proxy_set_header X-Forwarded-Proto https;', `            proxy_set_header X-Forwarded-Port ${port};`,
    '            proxy_set_header X-Forwarded-For "";', '            proxy_set_header X-Real-IP $remote_addr;', '            proxy_set_header Forwarded "";',
    '            proxy_set_header Upgrade $http_upgrade;', '            proxy_set_header Connection $connection_upgrade;',
    '            proxy_buffering off;', '            proxy_read_timeout 75s;', '        }', '    }', '}', '',
  ].join('\n');
  const unit = ['[Unit]', 'Description=CoCoProxy managed LAN HTTPS entry',
    'After=network-online.target cocoproxy-management.service', 'Wants=network-online.target', 'Requires=cocoproxy-management.service',
    '', '[Service]', 'Type=simple', `User=${input.serviceUid}`,
    `ExecStartPre=${web.nginxPath} -t -c ${configPath}`,
    `ExecStart=${web.nginxPath} -c ${configPath} -g "daemon off;"`,
    'Restart=on-failure', 'RestartSec=2', 'UMask=0077', 'RuntimeDirectory=cocoproxy-web', 'RuntimeDirectoryMode=0700',
    `StateDirectory=${tempNames.map(name => 'cocoproxy-web-' + name).join(' ')}`, 'StateDirectoryMode=0700',
    'NoNewPrivileges=true', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'ProtectHome=true',
    'PrivateTmp=true', 'PrivateDevices=true', 'ProtectKernelTunables=true', 'ProtectKernelModules=true',
    'ProtectControlGroups=true', 'RestrictSUIDSGID=true', 'RestrictAddressFamilies=AF_INET AF_UNIX',
    'ReadWritePaths=/run/cocoproxy-web ' + tempNames.map(tempPath).join(' '),
    '', '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  const files: DeploymentFile[] = [
    { path: configPath, mode: '0644', owner: 'root', sensitive: false, content },
    { path: unitPath, mode: '0644', owner: 'root', sensitive: false, content: unit },
  ];
  const directories: DeploymentPlan['directories'] = [
    { path: '/etc/cocoproxy/web', owner: 'root', mode: '0755' },
    { path: '/run/cocoproxy-web', owner: input.serviceUid, mode: '0700' },
    ...tempNames.map(name => ({ path: tempPath(name), owner: input.serviceUid, mode: '0700' as const })),
  ];
  return { settings: web, files, directories, hostname, port };
}

export interface ManagedWebStat {
  directory: boolean; file: boolean; link: boolean; uid: number; mode: number; nlink: number;
}
export interface ManagedWebHost {
  platform: string; uid: number;
  stat(path: string): Promise<ManagedWebStat>;
  read(path: string, limit: number): Promise<Buffer>;
}
const nativeHost = (): ManagedWebHost => ({ platform: process.platform, uid: process.getuid?.() ?? -1,
  stat: async path => { const s = await lstat(path); return { directory: s.isDirectory(), file: s.isFile(),
    link: s.isSymbolicLink(), uid: s.uid, mode: s.mode, nlink: s.nlink }; },
  read: async (path, limit) => {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail('SETUP_HTTPS_FILE_UNTRUSTED');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await handle.stat();
      if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino || s.nlink !== 1 || s.size > limit ||
          s.uid !== before.uid || s.mode !== before.mode) fail('SETUP_HTTPS_FILE_UNTRUSTED');
      const bytes = Buffer.alloc(limit + 1);
      let used = 0;
      while (used < bytes.length) { const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used); if (!bytesRead) break; used += bytesRead; }
      if (used > limit) fail('SETUP_HTTPS_FILE_UNTRUSTED');
      return bytes.subarray(0, used);
    } finally { await handle.close(); }
  },
});

/** Linux read-only prerequisite check. Does not run nginx, copy keys, or change trust stores. */
export async function verifyManagedWeb(input: ManagedWebInput, options: { host?: ManagedWebHost; now?: number } = {}): Promise<void> {
  const plan = renderManagedWeb(input), host = options.host ?? nativeHost();
  if (host.platform !== 'linux' || host.uid !== 0) fail('SETUP_HTTPS_LINUX_ROOT_REQUIRED');
  async function trustedFile(path: string, owner: number, privateKey: boolean, executable = false) {
    let parent = posix.dirname(path);
    for (;;) {
      const s = await host.stat(parent);
      if (!s.directory || s.link || s.uid !== 0 || (s.mode & 0o022) !== 0 || !(s.mode & 0o001)) fail('SETUP_HTTPS_PATH_UNTRUSTED');
      if (parent === '/') break;
      parent = posix.dirname(parent);
    }
    const s = await host.stat(path);
    if (!s.file || s.link || s.nlink !== 1 || s.uid !== owner ||
        (privateKey ? (s.mode & 0o7777) !== 0o600 : (s.mode & 0o022) !== 0 || !(s.mode & 0o004)) ||
        executable && (s.mode & 0o001) === 0) fail('SETUP_HTTPS_FILE_UNTRUSTED');
  }
  try {
    await trustedFile(plan.settings.nginxPath, 0, false, true);
    await trustedFile(plan.settings.certificatePath, 0, false);
    await trustedFile(plan.settings.privateKeyPath, input.serviceUid, true);
    const certificate = new X509Certificate(await host.read(plan.settings.certificatePath, 128 * 1024));
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now) || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now ||
        !Number.isFinite(Date.parse(certificate.validFrom)) || !Number.isFinite(Date.parse(certificate.validTo))) fail('SETUP_HTTPS_CERTIFICATE_EXPIRED');
    const match = isIP(plan.hostname) ? certificate.checkIP(plan.hostname) : certificate.checkHost(plan.hostname, { subject: 'never' });
    if (!match) fail('SETUP_HTTPS_CERTIFICATE_NAME_MISMATCH');
    const key = createPrivateKey(await host.read(plan.settings.privateKeyPath, 128 * 1024));
    if (!certificate.checkPrivateKey(key)) fail('SETUP_HTTPS_KEY_MISMATCH');
  } catch (error) {
    if (error instanceof ManagedWebError) throw error;
    fail('SETUP_HTTPS_PREFLIGHT_FAILED');
  }
}
