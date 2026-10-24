import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Internal storage errors never contain paths, bytes or OS diagnostics. */
export class PrivateFileError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'PrivateFileError'; this.code = code; }
}

const fail: (code: string) => never = code => { throw new PrivateFileError(code); };
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

export async function inspectPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORE');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid!())) fail('UNSAFE_STORE');
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform !== 'linux') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Caller must select an absolute path with trusted ancestors. No chmod/chown. */
export async function privateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await inspectPrivateDirectory(path);
  if (created && process.platform === 'linux') {
    const boundary = dirname(created);
    let current = path;
    for (;;) {
      await syncDirectory(current);
      if (current === boundary) break;
      current = dirname(current);
    }
  }
}

export async function privateRead(path: string, limit = 4 * 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) fail('STORE_LIMIT');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) fail('UNSAFE_STORE');
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid!()))) fail('UNSAFE_STORE');
    if (stat.size > limit) fail('STORE_LIMIT');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) fail('STORE_LIMIT');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { fail('STORE_CORRUPT'); }
  } finally { await handle.close(); }
}

/** Internal basename only. Mutations require the caller's shared store lock. */
export async function atomicWrite(directory: string, name: string, contents: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) fail('INVALID_STORE_NAME');
  const temporary = join(directory, '.write-' + randomUUID());
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(error => { if (errno(error) !== 'ENOENT') throw error; });
  }
}
