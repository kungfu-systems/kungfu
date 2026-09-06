// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PROOF_BOOTSTRAP_PACKAGES,
  installProofBootstrapPackages,
} from './install-proof-bootstrap-packages.mjs';
import { parseDocument } from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceOnlyModules = [
  'scripts/affected-native-proof.mjs',
  'scripts/dev-delivery-warrant-input.mjs',
  'scripts/project-cut-family-queue-lease.mjs',
  'scripts/run-core-affected-native.mjs',
  'scripts/affected-native-self-test-support.mjs',
  'scripts/candidate-timeline-events.cjs',
  'scripts/readonly-source-toolchain.mjs',
  'scripts/shifu-gate-evidence.mjs',
  'developer/dev-delivery/native-execution-under-warrant.mjs',
  'product/release/affected-native-artifact-lookup.mjs',
  'product/release/affected-native-proof-cli.mjs',
  'framework/spec/format/project-cut-canonical-json.mjs',
];

test('proof bootstrap needs only builtins and its declared offline workspace packages', () => {
  for (const relativePath of sourceOnlyModules) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/gu),
    ].map((match) => match[1]);
    assert.deepEqual(
      specifiers.filter(
        (specifier) =>
          !specifier.startsWith('node:') &&
          !specifier.startsWith('.') &&
          !Object.keys(PROOF_BOOTSTRAP_PACKAGES).some((name) =>
            specifier.startsWith(`${name}/`),
          ),
      ),
      [],
      `${relativePath} must run after only the offline bootstrap package installation`,
    );
  }
});

test('cold proof bootstrap uses normal package exports and rejects private imports', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-proof-packages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [
    ...sourceOnlyModules,
    'package.json',
    'product/package.json',
    'framework/spec/package.json',
  ]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  const probe = `import assert from 'node:assert/strict'; import {digest} from './scripts/affected-native-proof.mjs'; import './scripts/dev-delivery-warrant-input.mjs'; import {planFromChanged} from './scripts/run-core-affected-native.mjs'; import {runNativeExecutionUnderWarrant} from './developer/dev-delivery/native-execution-under-warrant.mjs'; assert.equal(typeof digest, 'function'); assert.equal(typeof planFromChanged, 'function'); assert.equal(typeof runNativeExecutionUnderWarrant, 'function'); await assert.rejects(import('@kungfu-tech/spec/format/project-cut-canonical-json.mjs'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`;
  const run = () =>
    spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: root,
      encoding: 'utf8',
    });
  assert.notEqual(
    run().status,
    0,
    'a cold checkout must install its declared packages',
  );
  installProofBootstrapPackages(root);
  installProofBootstrapPackages(root);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  fs.unlinkSync(path.join(root, 'scripts/project-cut-family-queue-lease.mjs'));
  const incomplete = run();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(incomplete.stderr, /project-cut-family-queue-lease.mjs/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  manifest.devDependencies['@kungfu-tech/spec'] = undefined;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  assert.throws(
    () => installProofBootstrapPackages(root),
    /declared workspace dependency/,
  );
});

test('cold native planning and fenced execution install declared packages before loading consumers', () => {
  const workflowDocument = parseDocument(
    fs.readFileSync(
      path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
      'utf8',
    ),
  );
  const actionDocument = parseDocument(
    fs.readFileSync(
      path.join(
        ROOT,
        '.github/actions/native-execution-under-warrant/action.yml',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(workflowDocument.errors, []);
  assert.deepEqual(actionDocument.errors, []);
  const workflow = workflowDocument.toJS();
  const action = actionDocument.toJS();
  for (const [label, steps, consumer] of [
    [
      'native planning',
      workflow.jobs.affected_native_shards.steps,
      'node scripts/run-core-affected-native.mjs',
    ],
    [
      'fenced execution',
      action.runs.steps,
      'node developer/dev-delivery/native-execution-under-warrant.mjs',
    ],
  ]) {
    const installation = steps.findIndex((step) =>
      step.run?.includes('node scripts/install-proof-bootstrap-packages.mjs'),
    );
    const evaluation = steps.findIndex((step) => step.run?.includes(consumer));
    assert.ok(evaluation >= 0, `${label}: consumer must remain covered`);
    assert.ok(
      installation >= 0 && installation < evaluation,
      `${label}: install declared dependencies before module evaluation`,
    );
    assert.equal(
      steps[installation].if,
      undefined,
      `${label}: bootstrap must run for every admitted cold checkout`,
    );
  }
});

test('protected Project Cut replay materializes its declared Work dependency closure', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-pr-auto-merge.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /name: Check out protected consumer adapter[\s\S]*name: Install protected Work consumer dependencies[\s\S]*corepack pnpm install --filter '@kungfu-tech\/work\.\.\.' --prod --frozen-lockfile --ignore-scripts[\s\S]*name: Produce exact Project Cut replay proof/u,
  );
});

test('protected Warrant binds repository authority to the PR base for fork heads', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-pr-auto-merge.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /test "\$GITHUB_REPOSITORY" = "\$\(jq -r '\.base\.repo\.full_name' "\$pull_request"\)"/u,
  );
  assert.match(
    workflow,
    /'\.base\.repo\.full_name == \$repository[\s\S]*and \.head\.sha == \$head/u,
  );
  assert.doesNotMatch(workflow, /\.head\.repo\.full_name == \$repository/u);
});
