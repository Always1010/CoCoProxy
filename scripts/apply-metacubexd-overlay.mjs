#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOverlay = join(project, 'integrations', 'metacubexd', 'overlay');
const defaultManifest = join(project, 'integrations', 'metacubexd', 'source-tree.json');
const commit = JSON.parse(await readFile(new URL('../integrations/metacubexd/components.json', import.meta.url), 'utf8')).management.commit;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const forbidden = new Set(['.git', '.local', 'node_modules', '.nuxt', '.output']);

export class OverlayError extends Error {
  constructor(code) { super(code); this.name = 'OverlayError'; this.code = code; }
}
const fail = code => { throw new OverlayError(code); };
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value)) fail('UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || forbidden.has(part.toLowerCase())
    || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('UNSAFE_PATH');
  return parts;
}

function within(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('PATH_ESCAPE');
}

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function rootDirectory(path) {
  if (!isAbsolute(path) || equalPath(resolve(path), parse(resolve(path)).root)) fail('DIRECTORY_INVALID');
  const absolute = resolve(path);
  const info = await inspect(absolute);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('DIRECTORY_INVALID');
  const actual = await realpath(absolute);
  if (!equalPath(absolute, actual)) fail('DIRECTORY_LINK');
  return actual;
}

async function checkedPath(root, path, createParents = false) {
  const parts = safePath(path);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    within(root, current);
    let info = await inspect(current);
    if (!info && createParents && i < parts.length - 1) {
      try { await mkdir(current); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      info = await inspect(current);
    }
    if (!info) continue;
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())
      || (i === parts.length - 1 && !info.isFile())) fail('UNSAFE_TARGET');
    within(root, await realpath(current));
  }
  return current;
}

async function readRegular(path, maxBytes = MAX_FILE_BYTES) {
  const info = await inspect(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail('FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maxBytes) fail('FILE_CHANGED');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes || bytes.length !== opened.size) fail('FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

async function overlayFiles(root, prefix = '') {
  const names = await readdir(prefix ? join(root, ...safePath(prefix)) : root);
  const result = [];
  for (const name of names.sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    safePath(path);
    const absolute = join(root, ...path.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail('OVERLAY_LINK');
    within(root, await realpath(absolute));
    if (info.isDirectory()) result.push(...await overlayFiles(root, path));
    else if (info.isFile()) result.push(path);
    else fail('OVERLAY_INVALID');
    if (result.length > 1000) fail('OVERLAY_LIMIT');
  }
  return result;
}

/** Optional source inputs support isolated synthetic validation; the CLI uses repository-owned inputs only. */
export async function applyMetacubexdOverlay(directory, { overlayDirectory = defaultOverlay, manifestPath = defaultManifest } = {}) {
  const target = await rootDirectory(directory);
  const overlay = await rootDirectory(overlayDirectory);
  // Never apply a vendor overlay to this project's authoritative checkout.
  if (equalPath(target, project) || equalPath(target, overlay)) fail('DIRECTORY_INVALID');
  const manifest = JSON.parse((await readRegular(manifestPath, 4 * 1024 * 1024)).toString('utf8'));
  if (manifest?.commit !== commit || manifest.truncated !== false || !Array.isArray(manifest.files)) fail('MANIFEST_INVALID');
  const originals = new Map();
  for (const entry of manifest.files) {
    safePath(entry?.path);
    if (!/^[a-f0-9]{40}$/.test(entry.sha) || !['100644', '100755', '120000'].includes(entry.mode) || originals.has(entry.path)) fail('MANIFEST_INVALID');
    originals.set(entry.path, entry);
  }
  const files = await overlayFiles(overlay);
  if (!files.length) fail('OVERLAY_EMPTY');
  const pending = [];
  let total = 0;
  // Validate the complete batch before creating directories or replacing files.
  for (const path of files) {
    const source = await checkedPath(overlay, path);
    const bytes = await readRegular(source);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('OVERLAY_LIMIT');
    const destination = await checkedPath(target, path);
    const info = await inspect(destination);
    const original = originals.get(path);
    if (original?.mode === '120000') fail('UNSAFE_TARGET');
    const next = blob(bytes);
    let previous = null;
    if (info) {
      previous = blob(await readRegular(destination));
      if (previous !== next && (!original || previous !== original.sha)) fail('SOURCE_DRIFT');
    } else if (original) fail('SOURCE_MISSING');
    pending.push({ path, bytes, next, previous, mode: original?.mode === '100755' ? 0o755 : 0o644 });
  }
  let written = 0;
  for (const item of pending) {
    if (item.previous === item.next) continue;
    const destination = await checkedPath(target, item.path, true);
    const current = await inspect(destination);
    if ((current ? blob(await readRegular(destination)) : null) !== item.previous) fail('SOURCE_CHANGED');
    const temporary = join(dirname(destination), `.cocoproxy-overlay-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), item.mode);
      await handle.writeFile(item.bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      await checkedPath(target, item.path);
      await rename(temporary, destination);
      written++;
    } finally {
      if (handle) await handle.close();
      try { await unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return { commit, checked: pending.length, written, unchanged: pending.length - written };
}

if (process.argv[1] && equalPath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--directory' || !args[1]) fail('CLI_USAGE');
    console.log(JSON.stringify(await applyMetacubexdOverlay(args[1])));
  } catch (error) {
    // Fixed codes deliberately omit paths, source content, and raw operating-system diagnostics.
    console.error(error instanceof OverlayError ? error.code : 'OVERLAY_FAILED');
    process.exitCode = 1;
  }
}
