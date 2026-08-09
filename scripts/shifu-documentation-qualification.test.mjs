// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDocumentationQualification,
  validateQualificationMatrix,
} from './shifu-documentation-qualification.mjs';

test('final documentation matrix binds product and multi-consumer roots', () => {
  const receipt = runDocumentationQualification();
  assert.equal(receipt.verdict, 'pass');
  assert.match(receipt.proofRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.product.valid, true);
  assert.equal(receipt.consumers.consumers.length, 2);
});

test('a second compiler or selector authority fails qualification', () => {
  const diagnostics = validateQualificationMatrix({
    authorities: { compiler: ['xinfa', 'shifu'], selector: ['xinfa'] },
    acceptance: [],
    compatibilityAliases: [],
  });
  assert.ok(diagnostics.some((item) => item.code === 'parallel-authority'));
});

test('an unbounded compatibility alias fails qualification', () => {
  const diagnostics = validateQualificationMatrix({
    authorities: { compiler: ['xinfa'], selector: ['xinfa'] },
    acceptance: [],
    compatibilityAliases: [
      { id: 'legacy', documentationCompiler: true, owner: '', sunset: '' },
    ],
  });
  assert.ok(
    diagnostics.some((item) => item.code === 'unbounded-compatibility-alias'),
  );
});
