import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyOfflineDocumentation } from '../scripts/release-layout.mjs';

test('offline guide checks project links while retaining unmodified upstream dependency documentation', () => {
  const files = new Map([
    ['README.md', Buffer.from('[Deploy](source/docs/remote-deployment.md)')],
    ['source/docs/remote-deployment.md', Buffer.from('Synthetic deployment guide')],
    ['source/node_modules/sample/README.md', Buffer.from('[Upstream tests](test/)')],
    ['server/.output/server/node_modules/sample/README.md', Buffer.from('[Sibling package](../sample-sibling)')],
  ]);
  assert.deepEqual(verifyOfflineDocumentation(files), { checked: 1 });
  files.delete('source/docs/remote-deployment.md');
  assert.throws(() => verifyOfflineDocumentation(files), error => error.code === 'DOCUMENT_LINK_MISSING');
});
