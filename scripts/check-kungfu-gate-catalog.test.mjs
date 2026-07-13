// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkKungfuGateCatalog,
  renderPolicyMatrix,
} from './check-kungfu-gate-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-gates-'));
  for (const relative of [
    'shifu.gates.json',
    'package.json',
    'docs/qualification/gates',
  ]) {
    const source = path.join(ROOT, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  const bindings = JSON.parse(
    fs.readFileSync(
      path.join(root, 'docs/qualification/gates/workflow-bindings.json'),
      'utf8',
    ),
  );
  for (const binding of bindings.bindings) {
    const source = path.join(ROOT, binding.workflow);
    const target = path.join(root, binding.workflow);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return root;
}

test('current Kungfu catalog, docs, matrix, actions, and workflows align', () => {
  const root = fixture();
  assert.deepEqual(checkKungfuGateCatalog(root).issues, []);
});

test('matrix rendering is deterministic and includes every profile', () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shifu.gates.json'), 'utf8'),
  );
  const matrix = renderPolicyMatrix(registry);
  for (const profile of registry.profiles) {
    assert.match(matrix, new RegExp(profile.id));
  }
  assert.equal(matrix.split('\n').length, registry.gates.length + 2);
});

test('matrix, gate document, and workflow drift each fail closed', () => {
  const root = fixture();
  const matrix = path.join(root, 'docs/qualification/gates/policy-matrix.md');
  fs.writeFileSync(
    matrix,
    fs.readFileSync(matrix, 'utf8').replace('| required |', '| off |'),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.startsWith('[matrix]'),
    ),
  );

  const docs = path.join(
    root,
    'docs/qualification/gates/source-and-governance.md',
  );
  fs.writeFileSync(
    docs,
    fs.readFileSync(docs, 'utf8').replace('- **Problem:**', '- **Question:**'),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes("missing 'Problem' field"),
    ),
  );

  const workflow = path.join(root, '.github/workflows/source-acceptance.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('mode: source', 'mode: changed'),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes("'mode: source' not found"),
    ),
  );

  const bindingsPath = path.join(
    root,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  bindings.bindings[0].gates.push('source.changed-scope');
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes('dev-pr:source.changed-scope is bound but policy is off'),
    ),
  );
});

test('document facts and Gate-owned workflow entrypoints fail closed', () => {
  const root = fixture();
  const docs = path.join(root, 'docs/qualification/gates/build-and-runtime.md');
  fs.writeFileSync(
    docs,
    fs
      .readFileSync(docs, 'utf8')
      .replace('`./shifu verify --full`', '`./shifu verify --quick`'),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some(
      (issue) =>
        issue.startsWith('[doc-fact] product.verify-full:') &&
        issue.includes('./shifu verify --full'),
    ),
  );

  const bindingsPath = path.join(
    root,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  const migration = bindings.bindings.find(
    (binding) => binding.id === 'dev-heavy-patrol',
  );
  migration.requiredSnippets = ['kungfu-build-v4-linux-x64'];
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes(
        "dev-heavy-patrol: gate execution must prove a 'gate run' entrypoint",
      ),
    ),
  );
});
