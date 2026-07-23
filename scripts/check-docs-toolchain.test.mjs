// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkDocsToolchain } from './check-docs-toolchain.mjs';

test('rejects mutable documentation Action refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-docs-toolchain-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs', 'toolchain.contract.json'),
      JSON.stringify({
        schemaVersion: 1,
        vale: {
          container: `vale@sha256:${'a'.repeat(64)}`,
          archives: { linux: { name: 'vale.tgz', sha256: 'b'.repeat(64) } },
        },
        githubActions: {
          'actions/checkout': { sha: 'c'.repeat(40) },
          'lycheeverse/lychee-action': { sha: 'd'.repeat(40) },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'docs-check.yml'),
      'uses: actions/checkout@v7\n',
    );
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'docs-external-links.yml'),
      'uses: actions/checkout@v7\nuses: lycheeverse/lychee-action@v2\n',
    );
    assert.ok(checkDocsToolchain(root).length >= 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
