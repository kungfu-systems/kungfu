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
  const result = checkKungfuGateCatalog(root);
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.workflowFacts.some(
      (fact) =>
        fact.execution === 'profile' &&
        fact.profile === 'dev-patrol' &&
        fact.workflow === '.github/workflows/dev-verify-patrol.yml' &&
        fact.job === 'verify',
    ),
  );
  assert.equal(
    result.workflowFacts.filter(
      (fact) =>
        fact.workflow === '.github/workflows/shifu-ci.yml' &&
        fact.job === 'check' &&
        fact.gates[0] === 'shifu.workspace',
    ).length,
    2,
  );
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

test('document facts and workflow entrypoints fail closed', () => {
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

  const gateWorkflow = path.join(
    root,
    '.github/workflows/adr-release-gate.yml',
  );
  fs.writeFileSync(
    gateWorkflow,
    fs
      .readFileSync(gateWorkflow, 'utf8')
      .replace(
        '          ./shifu gate run governance.adr-delivery',
        '          # ./shifu gate run governance.adr-delivery',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes('dev-adr: no structured gate invocation'),
    ),
  );

  const controllerRoot = fixture();
  const controllerBindingsPath = path.join(
    controllerRoot,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const controllerBindings = JSON.parse(
    fs.readFileSync(controllerBindingsPath, 'utf8'),
  );
  const controllerBinding = controllerBindings.bindings.find(
    (binding) => binding.id === 'dev-source',
  );
  const controllerWorkflow = path.join(
    controllerRoot,
    controllerBinding.workflow,
  );
  fs.writeFileSync(
    controllerWorkflow,
    fs
      .readFileSync(controllerWorkflow, 'utf8')
      .replace('mode: source', 'mode: changed'),
  );
  assert.ok(
    checkKungfuGateCatalog(controllerRoot).issues.some((issue) =>
      issue.includes("dev-source: 'mode: source' not found"),
    ),
  );
});

test('direct Gate invocations are discovered from YAML and must have one binding', () => {
  const rogueRoot = fixture();
  const rogue = path.join(rogueRoot, '.github/workflows/rogue.yml');
  fs.writeFileSync(
    rogue,
    'name: Rogue\njobs:\n  unbound:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./shifu gate run source.acceptance\n',
  );
  assert.ok(
    checkKungfuGateCatalog(rogueRoot).issues.some((issue) =>
      issue.includes(
        '.github/workflows/rogue.yml#unbound:source.acceptance: invocation has no matching binding',
      ),
    ),
  );

  const duplicateRoot = fixture();
  const bindingsPath = path.join(
    duplicateRoot,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  const duplicate = structuredClone(
    bindings.bindings.find((binding) => binding.id === 'dev-adr'),
  );
  duplicate.id = 'dev-adr-duplicate';
  bindings.bindings.push(duplicate);
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(duplicateRoot).issues.some((issue) =>
      issue.includes(
        'invocation matches multiple bindings (dev-adr, dev-adr-duplicate)',
      ),
    ),
  );
});

test('Gate and profile mismatch or dynamic ids fail closed', () => {
  const mismatchRoot = fixture();
  const mismatchWorkflow = path.join(
    mismatchRoot,
    '.github/workflows/adr-release-gate.yml',
  );
  fs.writeFileSync(
    mismatchWorkflow,
    fs
      .readFileSync(mismatchWorkflow, 'utf8')
      .replace('governance.adr-delivery', 'source.acceptance'),
  );
  assert.ok(
    checkKungfuGateCatalog(mismatchRoot).issues.some((issue) =>
      issue.includes(
        '#adr-release:source.acceptance: invocation has no matching binding',
      ),
    ),
  );

  const dynamicRoot = fixture();
  const dynamicWorkflow = path.join(
    dynamicRoot,
    '.github/workflows/adr-release-gate.yml',
  );
  fs.writeFileSync(
    dynamicWorkflow,
    fs
      .readFileSync(dynamicWorkflow, 'utf8')
      .replace('governance.adr-delivery', '${{ inputs.gate }}'),
  );
  assert.ok(
    checkKungfuGateCatalog(dynamicRoot).issues.some((issue) =>
      issue.includes('Gate id must be a static catalog id'),
    ),
  );

  const unknownRoot = fixture();
  const unknownWorkflow = path.join(
    unknownRoot,
    '.github/workflows/adr-release-gate.yml',
  );
  fs.writeFileSync(
    unknownWorkflow,
    fs
      .readFileSync(unknownWorkflow, 'utf8')
      .replace('governance.adr-delivery', 'governance.not-registered'),
  );
  assert.ok(
    checkKungfuGateCatalog(unknownRoot).issues.some((issue) =>
      issue.includes("unknown Gate 'governance.not-registered'"),
    ),
  );

  const profileRoot = fixture();
  const profileWorkflow = path.join(
    profileRoot,
    '.github/workflows/dev-verify-patrol.yml',
  );
  fs.writeFileSync(
    profileWorkflow,
    fs
      .readFileSync(profileWorkflow, 'utf8')
      .replace('gate-profile: dev-patrol', 'gate-profile: dev-pr'),
  );
  assert.ok(
    checkKungfuGateCatalog(profileRoot).issues.some((issue) =>
      issue.includes('#verify:dev-pr: invocation has no matching binding'),
    ),
  );

  const profilePolicyRoot = fixture();
  const bindingsPath = path.join(
    profilePolicyRoot,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  const profileBinding = bindings.bindings.find(
    (binding) => binding.id === 'dev-heavy-patrol',
  );
  profileBinding.gates = profileBinding.gates.filter(
    (gate) => gate !== 'docs.external-links',
  );
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(profilePolicyRoot).issues.some((issue) =>
      issue.includes('#verify:dev-patrol: invocation has no matching binding'),
    ),
  );
});
