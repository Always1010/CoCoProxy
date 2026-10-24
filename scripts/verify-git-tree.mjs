#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const READ_BUFFER_BYTES = 256 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}(?![\s\S])/;
const ALLOWED_MODES = new Set(['100644', '100755', '120000']);
const FORBIDDEN_SEGMENTS = new Set(['.git', '.local', 'node_modules']);

const ERRORS = Object.freeze({
  CLI_USAGE: 'Expected --directory <absolute path> --manifest <absolute path>.',
  DIRECTORY_INVALID: 'Source directory is invalid.',
  IO_ERROR: 'Source tree could not be verified.',
  MANIFEST_INPUT_INVALID: 'Manifest input is invalid.',
  MANIFEST_INVALID: 'Git tree manifest is invalid.',
  SIZE_LIMIT: 'Source tree exceeds the verification size limit.',
  TREE_MISMATCH: 'Source tree does not match the manifest.',
  TREE_UNSTABLE: 'Source tree changed during verification.',
});

export class GitTreeError extends Error {
  /** @param {keyof typeof ERRORS} code */
  constructor(code) {
    super(ERRORS[code]);
    this.name = 'GitTreeError';
    this.code = code;
  }
}

function fail(code) {
  throw new GitTreeError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (actual.some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) return false;
  actual.sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (posix.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || FORBIDDEN_SEGMENTS.has(segment))) return false;
  return posix.normalize(value) === value;
}

function validateManifest(manifest) {
  if (!isPlainRecord(manifest) || !hasExactKeys(manifest, ['commit', 'truncated', 'files'])) fail('MANIFEST_INVALID');
  if (typeof manifest.commit !== 'string' || !SHA1_PATTERN.test(manifest.commit)) fail('MANIFEST_INVALID');
  if (manifest.truncated !== false || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail('MANIFEST_INVALID');

  const files = new Map();
  const directories = new Set();
  for (const entry of manifest.files) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['mode', 'path', 'sha'])) fail('MANIFEST_INVALID');
    if (!validManifestPath(entry.path) || typeof entry.sha !== 'string' || !SHA1_PATTERN.test(entry.sha)) fail('MANIFEST_INVALID');
    if (typeof entry.mode !== 'string' || !ALLOWED_MODES.has(entry.mode) || files.has(entry.path)) fail('MANIFEST_INVALID');
    files.set(entry.path, { mode: entry.mode, sha: entry.sha });
    let parent = posix.dirname(entry.path);
    while (parent !== '.') {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  for (const filePath of files.keys()) {
    if (directories.has(filePath)) fail('MANIFEST_INVALID');
  }
  return { commit: manifest.commit, files, directories };
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameFileState(first, second) {
  return sameIdentity(first, second)
    && first.mode === second.mode
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs;
}

async function checkedLstat(pathname, errorCode = 'TREE_UNSTABLE') {
  try {
    return await lstat(pathname, { bigint: true });
  } catch {
    fail(errorCode);
  }
}

function addBlobHeader(hash, byteLength) {
  hash.update(`blob ${byteLength}\0`, 'utf8');
}

function isExecutable(state) {
  return (state.mode & 0o111n) !== 0n;
}

async function verifyRegularFile(pathname, expected, before, accountBytes) {
  const shouldExecute = expected.mode === '100755';
  if (expected.mode === '120000' || !before.isFile() || isExecutable(before) !== shouldExecute) fail('TREE_MISMATCH');
  if (before.size > BigInt(MAX_FILE_BYTES)) fail('SIZE_LIMIT');
  accountBytes(Number(before.size));

  let handle;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) fail('TREE_UNSTABLE');
    if (isExecutable(opened) !== shouldExecute) fail('TREE_MISMATCH');

    const byteLength = Number(opened.size);
    const hash = createHash('sha1');
    addBlobHeader(hash, byteLength);
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(byteLength, 1)));
    let position = 0;
    while (position < byteLength) {
      const length = Math.min(buffer.length, byteLength - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) fail('TREE_UNSTABLE');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (!sameFileState(opened, afterRead)) fail('TREE_UNSTABLE');
    if (hash.digest('hex') !== expected.sha) fail('TREE_MISMATCH');
  } catch (error) {
    if (error instanceof GitTreeError) throw error;
    fail('TREE_UNSTABLE');
  } finally {
    await handle?.close().catch(() => {});
  }

  const after = await checkedLstat(pathname);
  if (!after.isFile() || !sameFileState(before, after)) fail('TREE_UNSTABLE');
}

async function verifySymbolicLink(pathname, relativePath, expected, before, accountBytes) {
  if (expected.mode !== '120000' || !before.isSymbolicLink()) fail('TREE_MISMATCH');
  let target;
  try {
    target = await readlink(pathname, { encoding: 'buffer' });
  } catch {
    fail('TREE_UNSTABLE');
  }
  if (target.length > MAX_FILE_BYTES) fail('SIZE_LIMIT');
  accountBytes(target.length);

  let targetText;
  try {
    targetText = new TextDecoder('utf-8', { fatal: true }).decode(target);
  } catch {
    fail('TREE_MISMATCH');
  }
  if (targetText.length === 0 || posix.isAbsolute(targetText) || /[\u0000-\u001f\u007f]/u.test(targetText)) fail('TREE_MISMATCH');
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(relativePath), targetText));
  if (resolvedTarget === '..' || resolvedTarget.startsWith('../') || posix.isAbsolute(resolvedTarget)) fail('TREE_MISMATCH');

  const hash = createHash('sha1');
  addBlobHeader(hash, target.length);
  hash.update(target);
  if (hash.digest('hex') !== expected.sha) fail('TREE_MISMATCH');
  const after = await checkedLstat(pathname);
  if (!after.isSymbolicLink() || !sameFileState(before, after)) fail('TREE_UNSTABLE');
}

/**
 * Verify a directory against a fixed Git tree manifest.
 * @param {string} directory absolute source directory
 * @param {unknown} manifest parsed manifest object
 * @returns {Promise<{verified: true, commit: string, fileCount: number}>}
 */
export async function verifyGitTree(directory, manifest) {
  let parsed;
  try {
    parsed = validateManifest(manifest);
  } catch (error) {
    if (error instanceof GitTreeError) throw error;
    fail('MANIFEST_INVALID');
  }
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('DIRECTORY_INVALID');

  try {
    const rootBefore = await checkedLstat(directory, 'DIRECTORY_INVALID');
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) fail('DIRECTORY_INVALID');
    const seen = new Set();
    const observedDirectories = new Map([['', rootBefore]]);
    let totalBytes = 0;
    const accountBytes = byteLength => {
      totalBytes += byteLength;
      if (totalBytes > MAX_TREE_BYTES) fail('SIZE_LIMIT');
    };

    const walk = async relativeDirectory => {
      const absoluteDirectory = relativeDirectory === '' ? directory : resolve(directory, ...relativeDirectory.split('/'));
      const before = observedDirectories.get(relativeDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        fail('TREE_UNSTABLE');
      }
      entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
      for (const entry of entries) {
        const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
        const absolutePath = resolve(directory, ...relativePath.split('/'));
        const entryState = await checkedLstat(absolutePath);
        if (relativeDirectory === '' && entry.name === '.git' && entryState.isDirectory() && !entryState.isSymbolicLink()) continue;

        if (entryState.isDirectory()) {
          if (!parsed.directories.has(relativePath)) fail('TREE_MISMATCH');
          observedDirectories.set(relativePath, entryState);
          await walk(relativePath);
          continue;
        }

        const expected = parsed.files.get(relativePath);
        if (!expected) fail('TREE_MISMATCH');
        if (entryState.isSymbolicLink()) {
          await verifySymbolicLink(absolutePath, relativePath, expected, entryState, accountBytes);
        } else if (entryState.isFile()) {
          await verifyRegularFile(absolutePath, expected, entryState, accountBytes);
        } else {
          fail('TREE_MISMATCH');
        }
        seen.add(relativePath);
      }
      const after = await checkedLstat(absoluteDirectory);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameFileState(before, after)) fail('TREE_UNSTABLE');
    };

    await walk('');
    if (seen.size !== parsed.files.size) fail('TREE_MISMATCH');
    for (const [relativeDirectory, before] of observedDirectories) {
      const absoluteDirectory = relativeDirectory === '' ? directory : resolve(directory, ...relativeDirectory.split('/'));
      const after = await checkedLstat(absoluteDirectory);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameFileState(before, after)) fail('TREE_UNSTABLE');
    }
    return { verified: true, commit: parsed.commit, fileCount: seen.size };
  } catch (error) {
    if (error instanceof GitTreeError) throw error;
    fail('IO_ERROR');
  }
}

function parseArguments(arguments_) {
  if (arguments_.length !== 4) fail('CLI_USAGE');
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if ((name !== '--directory' && name !== '--manifest') || values.has(name) || typeof value !== 'string' || !isAbsolute(value)) fail('CLI_USAGE');
    values.set(name, value);
  }
  if (!values.has('--directory') || !values.has('--manifest')) fail('CLI_USAGE');
  return { directory: values.get('--directory'), manifest: values.get('--manifest') };
}

async function readManifestFile(pathname) {
  let handle;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (!state.isFile() || state.size > BigInt(MAX_MANIFEST_BYTES)) fail('MANIFEST_INPUT_INVALID');
    const size = Number(state.size);
    const bytes = Buffer.allocUnsafe(size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(bytes, position, size - position, position);
      if (bytesRead === 0) fail('MANIFEST_INPUT_INVALID');
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(state, after)) fail('MANIFEST_INPUT_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof GitTreeError) throw error;
    fail('MANIFEST_INPUT_INVALID');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function main() {
  try {
    const { directory, manifest: manifestPath } = parseArguments(process.argv.slice(2));
    const manifest = await readManifestFile(manifestPath);
    const result = await verifyGitTree(directory, manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const safe = error instanceof GitTreeError ? error : new GitTreeError('IO_ERROR');
    process.stderr.write(`${JSON.stringify({ error: { code: safe.code, message: safe.message } })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) await main();
