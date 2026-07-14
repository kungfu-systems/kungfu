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
  const controllers = result.workflowFacts.filter(
    (fact) => fact.execution === 'controller',
  );
  assert.equal(controllers.length, 6);
  assert.ok(controllers.every((fact) => fact.gates.length > 0));
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
      issue.includes('dev-source: adapter input drift at with.mode'),
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
      issue.includes('dev-source: adapter input drift at with.mode'),
    ),
  );
});

test('every controller class has a structured adapter and input drift fails closed', () => {
  const cases = [
    {
      id: 'dev-source',
      workflow: '.github/workflows/source-acceptance.yml',
      from: 'mode: source',
      to: 'mode: ${{ inputs.mode }}',
      drift: 'with.mode',
    },
    {
      id: 'all-pr-dco',
      workflow: '.github/workflows/dco.yml',
      from: 'BASE_SHA:',
      to: 'OLD_BASE_SHA:',
      drift: 'env.BASE_SHA',
    },
    {
      id: 'channel-buildchain-config',
      workflow: '.github/workflows/buildchain-validate.yml',
      from: 'require-lifecycle-stages: "install,check,build,verify"',
      to: 'require-lifecycle-stages: "install,check"',
      drift: 'with.require-lifecycle-stages',
    },
    {
      id: 'dev-external-links',
      workflow: '.github/workflows/docs-external-links.yml',
      from: 'failIfEmpty: true',
      to: 'failIfEmpty: false',
      drift: 'with.failIfEmpty',
    },
    {
      id: 'channel-heavy-build',
      workflow: '.github/workflows/build.yml',
      from: 'verify-command: node scripts/run-release-qualification.mjs',
      to: 'verify-command: ./shifu verify',
      drift: 'with.verify-command',
    },
    {
      id: 'release-admission',
      workflow: '.github/workflows/release-new-version.yml',
      from: 'required-artifact-count: 3',
      to: 'required-artifact-count: 2',
      drift: 'with.required-artifact-count',
    },
  ];
  for (const item of cases) {
    const root = fixture();
    const workflow = path.join(root, item.workflow);
    fs.writeFileSync(
      workflow,
      fs.readFileSync(workflow, 'utf8').replace(item.from, item.to),
    );
    assert.ok(
      checkKungfuGateCatalog(root).issues.some((issue) =>
        issue.includes(
          `[workflow-controller] ${item.id}: adapter input drift at ${item.drift}`,
        ),
      ),
      item.id,
    );
  }
});

test('rogue, duplicate, missing, and invalid controller adapters fail closed', () => {
  const rogueRoot = fixture();
  fs.writeFileSync(
    path.join(rogueRoot, '.github/workflows/rogue-controller.yml'),
    'name: Rogue controller\njobs:\n  source-copy:\n    uses: kungfu-systems/buildchain/.github/workflows/check.yml@v2-alpha\n    with:\n      buildchain-ref: v2-alpha\n      mode: source\n      upload-artifacts: true\n',
  );
  assert.ok(
    checkKungfuGateCatalog(rogueRoot).issues.some((issue) =>
      issue.includes(
        '.github/workflows/rogue-controller.yml#source-copy:job-uses:kungfu-systems/buildchain/.github/workflows/check.yml@v2-alpha: invocation has no matching binding',
      ),
    ),
  );

  const duplicateRoot = fixture();
  const duplicateWorkflow = path.join(
    duplicateRoot,
    '.github/workflows/buildchain-validate.yml',
  );
  fs.writeFileSync(
    duplicateWorkflow,
    fs
      .readFileSync(duplicateWorkflow, 'utf8')
      .replace(
        '      - name: Validate .buildchain/buildchain.toml',
        '      - name: Validate .buildchain/buildchain.toml\n        uses: kungfu-systems/buildchain/actions/validate-config@v2\n        with:\n          require-version-state: "true"\n          require-lifecycle-stages: "install,check,build,verify"\n      - name: Validate .buildchain/buildchain.toml',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(duplicateRoot).issues.some((issue) =>
      issue.includes(
        'channel-buildchain-config: expected one controller invocation, found 2',
      ),
    ),
  );

  const missingRoot = fixture();
  const missingWorkflow = path.join(missingRoot, '.github/workflows/dco.yml');
  fs.writeFileSync(
    missingWorkflow,
    fs
      .readFileSync(missingWorkflow, 'utf8')
      .replace(
        'name: Check commit sign-offs',
        'name: Unregistered shell check',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(missingRoot).issues.some((issue) =>
      issue.includes('all-pr-dco: no structured controller invocation'),
    ),
  );

  const commentRoot = fixture();
  const commentWorkflow = path.join(commentRoot, '.github/workflows/dco.yml');
  fs.writeFileSync(
    commentWorkflow,
    fs
      .readFileSync(commentWorkflow, 'utf8')
      .replace(
        '          commits="$(git rev-list "${BASE_SHA}..${HEAD_SHA}")"',
        '          # commits="$(git rev-list "${BASE_SHA}..${HEAD_SHA}")"',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(commentRoot).issues.some((issue) =>
      issue.includes('all-pr-dco: adapter input drift at run:git rev-list'),
    ),
  );

  const invalidRoot = fixture();
  const bindingsPath = path.join(
    invalidRoot,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  bindings.bindings.find((binding) => binding.id === 'dev-source').adapter =
    undefined;
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(invalidRoot).issues.some((issue) =>
      issue.includes('dev-source: adapter object is required'),
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

test('direct Gate arguments and profile inputs fail closed on drift', () => {
  const gateRoot = fixture();
  const gateWorkflow = path.join(gateRoot, '.github/workflows/shifu-ci.yml');
  fs.writeFileSync(
    gateWorkflow,
    fs
      .readFileSync(gateWorkflow, 'utf8')
      .replaceAll('--capability rust', '--capability node'),
  );
  assert.ok(
    checkKungfuGateCatalog(gateRoot).issues.some((issue) =>
      issue.includes(
        '[workflow-gate] shifu-workspace: invocation drift at args',
      ),
    ),
  );

  const profileRefRoot = fixture();
  const profileRefWorkflow = path.join(
    profileRefRoot,
    '.github/workflows/dev-verify-patrol.yml',
  );
  fs.writeFileSync(
    profileRefWorkflow,
    fs
      .readFileSync(profileRefWorkflow, 'utf8')
      .replace(
        '.gate-profile.yml@a6145efc210a961da0e5c63d7024d42061550f60',
        '.gate-profile.yml@v2-alpha',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(profileRefRoot).issues.some((issue) =>
      issue.includes(
        '[workflow-profile] dev-heavy-patrol: invocation drift at uses',
      ),
    ),
  );

  const profileInputRoot = fixture();
  const profileInputWorkflow = path.join(
    profileInputRoot,
    '.github/workflows/dev-verify-patrol.yml',
  );
  fs.writeFileSync(
    profileInputWorkflow,
    fs
      .readFileSync(profileInputWorkflow, 'utf8')
      .replace(
        'runner-preset: kungfu-v4-self-hosted',
        'runner-preset: portable',
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(profileInputRoot).issues.some((issue) =>
      issue.includes(
        '[workflow-profile] dev-heavy-patrol: invocation drift at with.runner-preset',
      ),
    ),
  );
});

test('schema v2 rejects missing invocation contracts and legacy snippets', () => {
  const root = fixture();
  const bindingsPath = path.join(
    root,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  const gateBinding = bindings.bindings.find(
    (binding) => binding.id === 'dev-adr',
  );
  gateBinding.invocation = undefined;
  const profileBinding = bindings.bindings.find(
    (binding) => binding.id === 'dev-heavy-patrol',
  );
  profileBinding.invocation = undefined;
  bindings.bindings.find(
    (binding) => binding.id === 'channel-heavy-build',
  ).requiredSnippets = ['verify-command:'];
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));

  const issues = checkKungfuGateCatalog(root).issues;
  assert.ok(
    issues.some((issue) =>
      issue.includes('dev-adr: gate invocation.args must be a string array'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes(
        'dev-heavy-patrol: profile invocation requires static uses and with object',
      ),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes(
        'channel-heavy-build: requiredSnippets is not an execution proof in schema v2',
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
