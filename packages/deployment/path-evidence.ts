import { posix } from 'node:path';

export interface PathStat { directory: boolean; file: boolean; link: boolean; uid: number; mode: number; nlink: number }
export interface PathEvidenceHost { info(path: string): Promise<PathStat | null>; resolve(path: string): Promise<string> }
export class PathEvidenceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function need(value: unknown, code: string): asserts value { if (!value) throw new PathEvidenceError(code); }
function absolute(path: string) {
  need(typeof path === 'string' && path.startsWith('/') && posix.normalize(path) === path && path !== '/' &&
    !/[\x00-\x20\x7f]/.test(path) && !path.split('/').includes('.local'), 'INSTALL_PATH_INVALID');
}
/** Same read-only ownership rules used by final installation. Missing leaves are explicit. */
export async function assertRootControlledPath(path: string, host: PathEvidenceHost, leafMissing = false) {
  absolute(path);
  let current = '';
  for (const part of path.slice(1).split('/')) {
    current += '/' + part;
    const stat = await host.info(current);
    if (!stat && leafMissing && current === path) return;
    need(stat && !stat.link && stat.uid === 0 && !(stat.mode & 0o022), 'INSTALL_ROOT_OWNERSHIP_REQUIRED');
    if (current !== path) need(stat.directory, 'INSTALL_DIRECTORY_REQUIRED');
  }
}
export async function assertTrustedExecutable(path: string, host: PathEvidenceHost) {
  let current = path;
  for (let count = 0; count < 16; count++) {
    const parts = current.slice(1).split('/'); let prefix = ''; let changed = false;
    for (let index = 0; index < parts.length; index++) {
      prefix += '/' + parts[index]; const stat = await host.info(prefix);
      need(stat, 'INSTALL_REQUIRED_SYSTEM_TOOL_MISSING');
      need(stat.uid === 0 && (stat.link || !(stat.mode & 0o022)), 'INSTALL_TOOL_UNTRUSTED');
      if (stat.link) {
        current = await host.resolve(prefix) + (index + 1 < parts.length ? '/' + parts.slice(index + 1).join('/') : '');
        changed = true; break;
      }
    }
    if (!changed) {
      await assertRootControlledPath(current, host);
      const stat = await host.info(current);
      need(stat?.file && (stat.mode & 0o111), 'INSTALL_TOOL_NOT_EXECUTABLE');
      return current;
    }
  }
  throw new PathEvidenceError('INSTALL_TOOL_LINK_LIMIT');
}
export async function assertServiceAncestors(path: string, host: PathEvidenceHost) {
  let parent = posix.dirname(path);
  while (parent !== '/') {
    const stat = await host.info(parent);
    if (stat) need(stat.directory && Boolean(stat.mode & 0o001), 'INSTALL_SERVICE_TRAVERSE_REQUIRED');
    parent = posix.dirname(parent);
  }
}
export async function assertPlannedDeploymentDirectory(directory: { path: string; owner: 'root' | number; mode: string },
  directories: readonly { path: string; owner: 'root' | number }[], host: PathEvidenceHost) {
  async function parent(path: string): Promise<void> {
    if (await host.info(path)) { await assertRootControlledPath(path, host); return; }
    need(directories.some(item => item.path === path && item.owner === 'root'), 'INSTALL_DIRECTORY_REQUIRED');
    await parent(posix.dirname(path));
  }
  await parent(posix.dirname(directory.path));
  const stat = await host.info(directory.path);
  if (stat) need(stat.directory && !stat.link && stat.uid === (directory.owner === 'root' ? 0 : directory.owner) &&
    (directory.mode === '0700' ? (stat.mode & 0o7777) === 0o700 : !(stat.mode & 0o022)), 'INSTALL_DIRECTORY_OWNERSHIP_CONFLICT');
}
