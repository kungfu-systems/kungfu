// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkShifuDocumentationContract } from './check-shifu-documentation-contract.mjs';
import {
  canonicalizeDocumentationSubmission,
  validateDocumentationSubmission,
} from './shifu-documentation-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');
const SUBMISSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'shifu.documentation.json'), 'utf8'),
);

function docs(args, options = {}) {
  return spawnSync(process.execPath, [SHIFU_MJS, 'docs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
}

test('documentation contract accepts Kungfu inputs and rejects every negative fixture', async () => {
  const result = await checkShifuDocumentationContract(ROOT);
  assert.equal(result.providers, 7);
  assert.equal(result.routes, 2);
  assert.ok(result.surfaces > 300);
  assert.equal(result.invalidFixtures, 6);
});

for (const [label, args, source] of [
  ['contract', ['contract'], 'docs/shifu/documentation-contract.json'],
  [
    'submission schema',
    ['schema', 'submission'],
    'docs/shifu/schema/documentation-project-v1.schema.json',
  ],
  [
    'receipt schema',
    ['schema', 'receipt'],
    'docs/shifu/schema/documentation-validation-receipt-v1.schema.json',
  ],
]) {
  test(`shifu exposes the exact checked-in documentation ${label}`, () => {
    const result = docs(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      fs.readFileSync(path.join(ROOT, source), 'utf8'),
    );
  });
}

test('validate emits a non-qualifying, non-self-certified receipt', () => {
  const result = docs(['validate', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, 'shifu.documentation-validation-receipt/v1');
  assert.equal(receipt.valid, true);
  assert.equal(receipt.qualifying, false);
  assert.equal(receipt.selfCertified, false);
  assert.match(receipt.roots.submission, /^sha256:[0-9a-f]{64}$/);
});

test('show emits deterministic roots independent of collection order', () => {
  const first = canonicalizeDocumentationSubmission(SUBMISSION);
  const reordered = structuredClone(SUBMISSION);
  reordered.providers.reverse();
  reordered.routes.reverse();
  reordered.documentProfiles.reverse();
  const second = canonicalizeDocumentationSubmission(reordered);
  assert.deepEqual(second.roots, first.roots);

  const result = docs(['show', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).roots, first.roots);
});

test('unknown fields and public routing of private providers fail visibly', () => {
  const unknown = structuredClone(SUBMISSION);
  unknown.project.unowned = true;
  assert.ok(
    validateDocumentationSubmission(unknown).diagnostics.some(
      (item) => item.code === 'unknown-field',
    ),
  );
  const privateProvider = structuredClone(SUBMISSION);
  privateProvider.providers[0].visibility = 'private';
  assert.ok(
    validateDocumentationSubmission(privateProvider).diagnostics.some(
      (item) => item.code === 'visibility-broadening',
    ),
  );
  const privateRoot = structuredClone(SUBMISSION);
  privateRoot.roots.find((root) => root.id === 'documentation').visibility =
    'private';
  assert.ok(
    validateDocumentationSubmission(privateRoot).diagnostics.some(
      (item) => item.code === 'visibility-broadening',
    ),
  );
});

test('CLI JSON diagnostics are stable for the same invalid fixture', () => {
  const fixture = structuredClone(SUBMISSION);
  fixture.providers[0].visibility = 'private';
  const input = JSON.stringify(fixture);
  const first = docs(['validate', '--submission', '-', '--json'], { input });
  const second = docs(['validate', '--submission', '-', '--json'], { input });
  assert.equal(first.status, 1, first.stderr);
  assert.equal(second.status, 1, second.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  const secondReceipt = JSON.parse(second.stdout);
  assert.equal(firstReceipt.roots, null);
  assert.deepEqual(secondReceipt.diagnostics, firstReceipt.diagnostics);
  assert.deepEqual(secondReceipt.submission, firstReceipt.submission);
});

test('stdin validation rejects malformed JSON without executing anything', () => {
  const result = docs(['validate', '--submission', '-', '--json'], {
    input: '{not-json',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.valid, false);
  assert.equal(receipt.diagnostics[0].code, 'json');
});

test('Shifu delegates Atlas compilation and verification to the public Xinfa CLI', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-xinfa-adapter-'),
  );
  try {
    const fake = path.join(temporary, 'xinfa');
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'atlas' && args[1] === 'compile') {
  process.stdout.write(JSON.stringify({schema:'xinfa.atlas-compile-receipt/v1',verdict:'pass',atlas_root:'sha256:${'a'.repeat(64)}'}));
} else if (args[0] === 'atlas' && args[1] === 'verify') {
  process.stdout.write(JSON.stringify({schema:'xinfa.atlas-verification-receipt/v1',valid:true,atlas_root:'sha256:${'a'.repeat(64)}'}));
} else process.exit(2);
`,
    );
    fs.chmodSync(fake, 0o755);
    const output = path.join(temporary, 'atlas');
    const result = docs([
      'xinfa',
      'compile',
      '--project',
      'xinfa/fixtures/repository-small/project.json',
      '--root',
      'xinfa/fixtures/repository-small',
      '--output',
      output,
      '--xinfa',
      fake,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(
      receipt.schema,
      'shifu.documentation-xinfa-adapter-receipt/v1',
    );
    assert.equal(receipt.delegated, true);
    assert.equal(receipt.submission.valid, true);
    assert.equal(receipt.xinfa.compile.atlas_root, `sha256:${'a'.repeat(64)}`);
    assert.equal(receipt.xinfa.verify.valid, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('surface inventory closes tracked prose and emits an exact Xinfa project', () => {
  const inventory = docs(['inventory', '--json']);
  assert.equal(inventory.status, 0, inventory.stderr);
  const value = JSON.parse(inventory.stdout);
  assert.equal(value.schema, 'shifu.documentation-surface-inventory/v1');
  assert.equal(value.closure.unclassified, 0);
  assert.ok(value.closure.discovered > 300);
  assert.equal(value.closure.classified, value.entries.length);
  assert.ok(value.lifecycles.authored > 0);
  assert.ok(value.lifecycles['historical-append-only'] > 0);

  const project = docs(['inventory', '--format', 'xinfa-project', '--json']);
  assert.equal(project.status, 0, project.stderr);
  const submission = JSON.parse(project.stdout);
  assert.equal(submission.schema, 'xinfa.project/v1');
  assert.equal(submission.providers[0].kind, 'exact-file-manifest');
  assert.deepEqual(submission.routes[0].nodes, submission.routes[1].nodes);
});
