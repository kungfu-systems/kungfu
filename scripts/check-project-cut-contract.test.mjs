// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProjectCut,
  canonicalJson,
  createProjectCutReceipt,
  parseRootJson,
  semanticRoot,
  verifyProjectCut,
  verifyProjectCutReceipt,
} from '../framework/project-cut/src/project-cut.mjs';
import {
  checkProjectCutContract,
  loadProjectCutFixture,
} from './project-cut-contract.mjs';

function reverseObjectOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectOrder(child)]),
  );
}

test('Project Cut contract, schema bundle, golden roots, and negative fixtures are welded', () => {
  const result = checkProjectCutContract();
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.protocolRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.schemaFiles, 4);
  assert.ok(['passed', 'skipped'].includes(result.schemaValidation));
  assert.equal(
    result.schemaFixtures,
    result.schemaValidation === 'passed' ? 5 : 0,
  );
  assert.equal(result.negativeFixtures, 12);
});

test('object field order cannot change semantic or serialization roots', () => {
  const base = loadProjectCutFixture();
  const reorderedInput = reverseObjectOrder(base.fixture.projectCutInput);
  reorderedInput.sourceProjection.root = base.projection.root;
  reorderedInput.sourceProjection.policyRoot = base.policy.policyRoot;
  const cut = buildProjectCut(reorderedInput, base.options);
  const receipt = createProjectCutReceipt(cut, null, base.options);
  assert.equal(cut.cutRoot, base.cut.cutRoot);
  assert.equal(receipt.serializationRoot, base.receipt.serializationRoot);
  assert.equal(receipt.artifactDigest, base.receipt.artifactDigest);
  assert.equal(receipt.receiptRoot, base.receipt.receiptRoot);
});

test('cut root, serialization root, artifact digest, and receipt root are separate identities', () => {
  const base = loadProjectCutFixture();
  assert.notEqual(base.cut.cutRoot, base.receipt.serializationRoot);
  assert.notEqual(base.receipt.serializationRoot, base.receipt.artifactDigest);
  assert.notEqual(base.receipt.artifactDigest, base.receipt.receiptRoot);
  const prettyBytes = Buffer.from(`${JSON.stringify(base.cut, null, 2)}\n`);
  const prettyReceipt = createProjectCutReceipt(
    base.cut,
    prettyBytes,
    base.options,
  );
  assert.equal(prettyReceipt.cutRoot, base.receipt.cutRoot);
  assert.equal(prettyReceipt.serializationRoot, base.receipt.serializationRoot);
  assert.notEqual(prettyReceipt.artifactDigest, base.receipt.artifactDigest);
});

test('publication coordinates are not admitted into a Project Cut root preimage', () => {
  const base = loadProjectCutFixture();
  const withCommit = { ...base.cut, containingGitCommitOid: 'a'.repeat(40) };
  const result = verifyProjectCut(withCommit, base.options);
  assert.ok(result.diagnostics.some(({ code }) => code === 'unknown-field'));
  assert.ok(!result.diagnostics.some(({ code }) => code === 'root-mismatch'));
});

test('canonical JSON rejects ambiguous text and number encodings', () => {
  assert.throws(() => canonicalJson({ path: 'cafe\u0301' }), {
    code: 'non-canonical-unicode',
  });
  assert.throws(() => canonicalJson({ number: -0 }), {
    code: 'non-canonical-number',
  });
  assert.throws(() => canonicalJson({ number: 1.5 }), {
    code: 'non-canonical-number',
  });
  assert.throws(() => canonicalJson({ number: -1 }), {
    code: 'non-canonical-number',
  });
  assert.throws(() => parseRootJson('{"root":1,"root":2}'), {
    code: 'duplicate-object-key',
  });
  assert.throws(
    () => parseRootJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    { code: 'non-canonical-encoding' },
  );
  assert.throws(() => parseRootJson(Buffer.from([0xc3, 0x28])), {
    code: 'non-canonical-encoding',
  });
});

test('semantic parent availability is independent of Git ancestry', () => {
  const base = loadProjectCutFixture();
  const unavailable = verifyProjectCut(base.cut, {
    ...base.options,
    availableParentRoots: [],
  });
  assert.ok(
    unavailable.diagnostics.some(({ code }) => code === 'parent-mismatch'),
  );
  const available = verifyProjectCut(base.cut, base.options);
  assert.equal(available.valid, true);
});

test('receipt verification detects artifact-byte drift without changing semantic identity', () => {
  const base = loadProjectCutFixture();
  const result = verifyProjectCutReceipt(
    base.receipt,
    base.cut,
    Buffer.from('different artifact bytes\n'),
    base.options,
  );
  assert.ok(result.diagnostics.some(({ code }) => code === 'receipt-mismatch'));
  assert.equal(semanticRoot(base.cut), base.receipt.serializationRoot);
});
