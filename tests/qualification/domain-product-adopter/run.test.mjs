// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const FIXTURE = path.join(ROOT, 'tests/fixtures/domain-product-adopter');
const require = createRequire(import.meta.url);

function copyPackage(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: true });
}

function packageRoot(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

function prepareCleanRoom(root) {
  fs.cpSync(FIXTURE, path.join(root, 'fixture'), { recursive: true });
  const scope = path.join(root, 'node_modules/@kungfu-tech');
  fs.mkdirSync(scope, { recursive: true });
  for (const name of ['kfd', 'buildchain']) {
    copyPackage(packageRoot(`@kungfu-tech/${name}`), path.join(scope, name));
  }
  const core = path.join(scope, 'core');
  fs.mkdirSync(core, { recursive: true });
  for (const relative of [
    'package.json',
    'core-platform-package.contract.json',
    'node-api-authority.json',
    'lib',
  ]) {
    copyPackage(
      path.join(ROOT, 'framework/core', relative),
      path.join(core, relative),
    );
  }
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
}

test('independent domain product qualifies from package-only clean room', (t) => {
  const cleanRoom = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-domain-product-'),
  );
  t.after(() => fs.rmSync(cleanRoom, { recursive: true, force: true }));
  prepareCleanRoom(cleanRoom);
  const child = spawnSync(process.execPath, ['fixture/qualify.mjs'], {
    cwd: cleanRoom,
    encoding: 'utf8',
    env: {
      HOME: path.join(cleanRoom, 'home'),
      LANG: 'C.UTF-8',
      PATH: process.env.PATH,
      TMPDIR: cleanRoom,
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(ROOT), false);
  const result = JSON.parse(child.stdout);
  assert.equal(result.passed, true);
  assert.equal(result.packageOnly, true);
  assert.equal(result.golden.status, 'passed');
  assert.equal(result.golden.gate.status, 'passed');
  assert.equal(result.golden.gate.qualifying, false);
  assert.equal(result.golden.gate.selfCertified, false);
  assert.equal(result.golden.runtime.eventCount, 2);
  assert.equal(result.golden.fault.rejected, true);
  assert.equal(result.golden.recovery.matchesLiveState, true);
  assert.deepEqual(
    result.negativeVectors.map(({ vector, status }) => ({ vector, status })),
    [
      { vector: 'copied-kungfu-roots', status: 'failed' },
      { vector: 'undeclared-primitive', status: 'failed' },
      { vector: 'runtime-fault-omission', status: 'failed' },
      { vector: 'recovery-substitution', status: 'failed' },
    ],
  );
  const issueCodes = Object.fromEntries(
    result.negativeVectors.map(({ vector, issueCodes: codes }) => [
      vector,
      codes,
    ]),
  );
  assert.equal(
    issueCodes['copied-kungfu-roots'].includes('domain-evidence-root-mismatch'),
    true,
  );
  assert.equal(
    issueCodes['undeclared-primitive'].includes('domain-primitive-undeclared'),
    true,
  );
  assert.equal(
    issueCodes['runtime-fault-omission'].includes('acp-evidence-missing'),
    true,
  );
  assert.equal(
    issueCodes['recovery-substitution'].includes(
      'domain-evidence-root-mismatch',
    ),
    true,
  );
});
