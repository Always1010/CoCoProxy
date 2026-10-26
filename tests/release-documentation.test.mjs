import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyDocumentationLinks } from '../scripts/release-layout.mjs';

test('guide checks local links without requiring upstream dependency documentation targets', () => {
  const files = new Map([
    ['README.md', Buffer.from('[Entry](cocoproxy)')],
    ['cocoproxy', Buffer.from('#!/bin/sh\n')],
    ['source/node_modules/sample/README.md', Buffer.from('[Upstream tests](test/)')],
    ['server/.output/server/node_modules/sample/README.md', Buffer.from('[Sibling package](../sample-sibling)')],
  ]);
  assert.deepEqual(verifyDocumentationLinks(files), { checked: 1 });
  files.delete('cocoproxy');
  assert.throws(() => verifyDocumentationLinks(files), error => error.code === 'DOCUMENT_LINK_MISSING');
});

test('repository documentation resolves against source files independently of the install payload', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const names = execFileSync('git', ['ls-files', '-z'],
    { cwd: project, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  const files = new Map(await Promise.all(names.map(async path => [path,
    path.endsWith('.md') ? await readFile(new URL(`../${path}`, import.meta.url)) : Buffer.alloc(0)])));
  assert.ok(verifyDocumentationLinks(files).checked > 50);
});
