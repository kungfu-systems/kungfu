// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveGitBoundKfdEvidenceSourceSha } from '../framework/release/buildchain-kfd-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('KFD evidence runtime adapts the repository-bound Git reader for queue replay', () => {
  const sourceSha = 'a'.repeat(40);
  const resolved = resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write: false,
    committed: sourceSha,
    configured: sourceSha,
    prepareHistory: () => {},
    selectSourceSha: () => sourceSha,
    assertBinding: ({
      sourceSha: selectedSourceSha,
      headSha,
      findTreeEquivalentAncestor,
    }) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.equal(
        findTreeEquivalentAncestor(selectedSourceSha, headSha),
        'c'.repeat(40),
      );
      return selectedSourceSha;
    },
    findTreeEquivalentAncestor: (selectedSourceSha, headSha, gitRead) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.match(headSha, /^[0-9a-f]{40}$/u);
      assert.equal(typeof gitRead, 'function');
      assert.equal(gitRead(['rev-parse', 'HEAD']), headSha);
      return 'c'.repeat(40);
    },
  });
  assert.equal(resolved, sourceSha);
});

test('KFD evidence runtime hydrates a recovered write source before binding', () => {
  const sourceSha = 'a'.repeat(40);
  let prepared = false;
  const resolved = resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write: true,
    committed: '',
    configured: sourceSha,
    prepareHistory: (root, options) => {
      assert.equal(root, ROOT);
      assert.deepEqual(options, { requiredCommit: sourceSha });
      prepared = true;
    },
    selectSourceSha: ({ write, configured }) => {
      assert.equal(write, true);
      assert.equal(configured, sourceSha);
      return sourceSha;
    },
    assertBinding: ({ sourceSha: selectedSourceSha, headSha }) => {
      assert.equal(prepared, true);
      assert.equal(selectedSourceSha, sourceSha);
      assert.match(headSha, /^[0-9a-f]{40}$/u);
      return selectedSourceSha;
    },
    findTreeEquivalentAncestor: () => '',
  });
  assert.equal(resolved, sourceSha);
});
