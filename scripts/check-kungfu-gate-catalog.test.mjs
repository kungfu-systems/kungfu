// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkKungfuGateCatalog,
  focusedMeasurementStaleGateIdsFromEnv,
  renderPolicyMatrix,
  validateMeasurementCoverage,
} from './check-kungfu-gate-catalog.mjs';
import {
  projectWorkflowAuthority,
  validateWorkflowAuthority,
} from './kungfu-workflow-authority.mjs';
import { gateDefinitionDigest, gateDigest } from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function copyFixturePath(root, relative) {
  const target = path.join(root, relative);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(ROOT, relative), target, { recursive: true });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-gates-'));
  for (const relative of [
    'shifu.gates.json',
    'package.json',
    '.buildchain/alpha-contract-lock.json',
    '.buildchain/contract-lock.json',
    '.github/workflows',
    'node_modules/@kungfu-tech/buildchain/package.json',
    'node_modules/@kungfu-tech/buildchain/dist/site/buildchain-contract.json',
    'node_modules/@kungfu-tech/buildchain/dist/site/publication-authority-registry.json',
    'docs/qualification/gates',
    'docs/qualification/evidence/kungfu-temporal-release-admission-facts.json',
    'framework/primitive/kungfu-primitive-catalog.contract.json',
    'config/primitive/kungfu-primitive-catalog.contract.json',
    'docs/qualification/evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json',
    'docs/qualification/evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json',
    'docs/qualification/evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json',
    'docs/qualification/evidence/gate-measurements/e978a4c85/linux/governance.dco.controller-receipt.json',
    'docs/qualification/evidence/gate-measurements/e90b0fb2b/linux/governance.dco.controller-receipt.json',
    'docs/qualification/evidence/gate-measurements/e90b0fb2b/linux/governance.buildchain-config.controller-receipt.json',
    'docs/qualification/evidence/gate-measurements/e90b0fb2b/linux/receipt.json',
    'docs/qualification/evidence/gate-measurements/e90b0fb2b/macos/receipt.json',
    'docs/qualification/evidence/gate-measurements/e90b0fb2b/windows/receipt.json',
    'framework/core/tests/qualification/episode/profiles',
  ]) {
    copyFixturePath(root, relative);
  }
  const coverage = readJson(
    ROOT,
    'docs/qualification/gates/measurement-coverage.json',
  );
  for (const relative of new Set(
    coverage.measurements.flatMap((record) =>
      record.observations.map((observation) => observation.receipt),
    ),
  )) {
    copyFixturePath(root, relative);
  }
  return root;
}

test('the single required dev workflow is merge-queue compatible', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(source, /^\s{2}pull_request\s*:/m);
  assert.match(source, /^\s{2}merge_group\s*:/m);
  assert.doesNotMatch(source, /github\.event\.pull_request/);

  for (const relative of [
    '.github/workflows/adr-release-gate.yml',
    '.github/workflows/source-acceptance.yml',
    '.github/workflows/docs-check.yml',
  ]) {
    const diagnostic = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(diagnostic, /^\s{2}workflow_dispatch\s*:/m, relative);
    assert.doesNotMatch(diagnostic, /^\s{2}pull_request\s*:/m, relative);
    assert.doesNotMatch(diagnostic, /^\s{2}merge_group\s*:/m, relative);
  }
});

test('PR proof overlaps source acceptance with heavy gates before exact queue reuse', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  const native = source.slice(
    source.indexOf('  affected_native_shards:\n'),
    source.indexOf('  shifu_workspace:\n'),
  );
  assert.doesNotMatch(native, /- source_acceptance/);
  assert.doesNotMatch(native, /needs\.source_acceptance/);
  assert.match(native, /- candidate_preflight[\s\S]*- proof_probe/);
  assert.match(native, /needs\.proof_probe\.outputs\.reuse != 'true'/);
  assert.doesNotMatch(native, /if:.*merge_group.*runs-on:/su);
  const aggregate = source.slice(source.indexOf('  affected_native:\n'));
  const cancellation = source.slice(
    source.indexOf('  cancel_after_source_failure:\n'),
    source.indexOf('  candidate_buildchain_config:\n'),
  );
  assert.match(
    cancellation,
    /needs: source_acceptance[\s\S]*needs\.source_acceptance\.result != 'success'[\s\S]*permissions:\n {6}actions: write[\s\S]*repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID\/cancel/,
  );
  assert.doesNotMatch(cancellation, /run_id|head_sha|workflow_id/);
  assert.match(aggregate, /- source_acceptance/);
  assert.match(
    aggregate,
    /SOURCE_RESULT:[\s\S]*require_result "source acceptance" success "\$SOURCE_RESULT"/,
  );
  assert.match(aggregate, /require_optional_gate "PR affected-native"/);
  assert.match(source, /producer-event[\s\S]*producer-head-sha/);
  assert.match(source, /Upload authoritative producer proof/);
});

test('Initiative-family queue lease is exact-head and dequeue-released', () => {
  const affectedNative = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(
    affectedNative,
    /name: Verify exact Initiative-family queue lease/,
  );
  assert.match(
    affectedNative,
    /--verify-family-marker "\$RUNNER_TEMP\/family-pr-body\.txt"/,
  );
  assert.match(affectedNative, /--expected-pr-head "\$pr_head"/);
  assert.match(affectedNative, /--expected-dev-head "\$MERGE_GROUP_BASE_SHA"/);
  assert.match(affectedNative, /--candidate-tree "\$candidate_tree"/);

  const dequeue = fs.readFileSync(
    path.join(ROOT, '.github/workflows/cancel-dequeued-merge-group.yml'),
    'utf8',
  );
  assert.match(
    dequeue,
    /DEQUEUED_PULL_REQUEST_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/,
  );
  assert.match(dequeue, /statuses: write/);
  assert.match(dequeue, /pull-requests: write/);
});

function readMeasurementCoverage(root) {
  return readJson(root, 'docs/qualification/gates/measurement-coverage.json');
}

function writeMeasurementCoverage(root, document) {
  fs.writeFileSync(
    path.join(root, 'docs/qualification/gates/measurement-coverage.json'),
    JSON.stringify(document, null, 2),
  );
}

test('focused measurement bootstrap is exact and fail-closed', () => {
  assert.deepEqual(
    focusedMeasurementStaleGateIdsFromEnv({
      KUNGFU_GATE_MEASUREMENT_BOOTSTRAP: 'focused-diagnostic-v1',
      KUNGFU_GATE_MEASUREMENT_FOCUS: 'source.acceptance',
    }),
    ['source.acceptance'],
  );
  for (const focus of ['', 'source.acceptance,source.acceptance', 'Source']) {
    assert.deepEqual(
      focusedMeasurementStaleGateIdsFromEnv({
        KUNGFU_GATE_MEASUREMENT_BOOTSTRAP: 'focused-diagnostic-v1',
        KUNGFU_GATE_MEASUREMENT_FOCUS: focus,
      }),
      [],
    );
  }
  assert.deepEqual(
    focusedMeasurementStaleGateIdsFromEnv({
      KUNGFU_GATE_MEASUREMENT_BOOTSTRAP: 'unexpected',
      KUNGFU_GATE_MEASUREMENT_FOCUS: 'source.acceptance',
    }),
    [],
  );
});

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
  assert.equal(controllers.length, 12);
  assert.ok(controllers.every((fact) => fact.gates.length > 0));
  assert.equal(result.workflowAuthority.workflows.length, 38);
  const agentPatrol = result.workflowAuthority.workflows.find(
    (workflow) => workflow.path === '.github/workflows/kungfu-agent-patrol.yml',
  );
  assert.equal(agentPatrol?.authority, 'qualification');
  assert.deepEqual(
    agentPatrol?.jobs.map(({ id, receipt }) => ({ id, receipt })),
    [{ id: 'patrol', receipt: 'diagnostic' }],
  );
  const linuxArm64Qualification = result.workflowAuthority.workflows.find(
    (workflow) =>
      workflow.path === '.github/workflows/linux-arm64-alpha-qualification.yml',
  );
  assert.equal(linuxArm64Qualification?.authority, 'qualification');
  assert.deepEqual(
    linuxArm64Qualification?.jobs.map(({ id, receipt }) => ({ id, receipt })),
    [
      { id: 'artifact', receipt: 'diagnostic' },
      { id: 'preflight', receipt: 'diagnostic' },
    ],
  );
  const alphaPreflight = result.workflowAuthority.workflows.find(
    (workflow) =>
      workflow.path === '.github/workflows/alpha-promotion-preflight.yml',
  );
  assert.equal(alphaPreflight?.authority, 'qualification');
  assert.deepEqual(
    alphaPreflight?.jobs.map(({ id, credentials, publication, receipt }) => ({
      id,
      githubToken: credentials.githubToken,
      publication,
      receipt,
    })),
    [
      {
        id: 'aggregate',
        githubToken: 'read',
        publication: 'none',
        receipt: 'diagnostic',
      },
      {
        id: 'probe',
        githubToken: 'read',
        publication: 'none',
        receipt: 'diagnostic',
      },
    ],
  );
});

test('an omitted workflow dependency stays required and distinctly bound', () => {
  const root = fixture();
  const file = path.join(
    root,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  document.bindings = document.bindings.filter(({ id }) => id !== 'dev-source');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  assert.ok(
    checkKungfuGateCatalog(root).issues.includes(
      '[workflow-omission] dev-core-affected-native: dev-pr:source.acceptance has no distinct workflow binding',
    ),
  );
});

test('workflow authority rejects unknown workflows, jobs, steps, and activation drift', () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/unknown.yml'),
    'name: Unknown\non: workflow_dispatch\njobs: {}\n',
  );
  assert.ok(
    validateWorkflowAuthority(root).issues.some((issue) =>
      issue.includes('workflow inventory drift'),
    ),
  );
  fs.rmSync(path.join(root, '.github/workflows/unknown.yml'));

  const workflow = path.join(root, '.github/workflows/dco.yml');
  const original = fs.readFileSync(workflow, 'utf8');
  fs.writeFileSync(
    workflow,
    original.replace(
      'jobs:\n',
      'jobs:\n  unknown-job:\n    runs-on: ubuntu-latest\n    steps: []\n',
    ),
  );
  assert.ok(
    validateWorkflowAuthority(root).issues.some((issue) =>
      issue.includes('dco.yml job inventory drift'),
    ),
  );
  fs.writeFileSync(
    workflow,
    original.replace(
      '    steps:\n',
      '    steps:\n      - name: Unknown step\n        run: echo unexpected\n',
    ),
  );
  assert.ok(
    validateWorkflowAuthority(root).issues.some((issue) =>
      issue.includes('dco.yml#signoff step inventory drift'),
    ),
  );
  fs.writeFileSync(
    workflow,
    original.replace('contents: read', 'contents: write'),
  );
  const activationOrPermissionIssues = validateWorkflowAuthority(root).issues;
  assert.ok(
    activationOrPermissionIssues.some((issue) =>
      issue.includes('dco.yml definition drift'),
    ),
  );
  assert.ok(
    activationOrPermissionIssues.some((issue) =>
      issue.includes('dco.yml#signoff credentials drift'),
    ),
  );
});

test('refreshing digests cannot authorize a mutable action in an authority-bearing workflow', () => {
  const root = fixture();
  const workflow = path.join(root, '.github/workflows/source-acceptance.yml');
  fs.writeFileSync(
    workflow,
    fs
      .readFileSync(workflow, 'utf8')
      .replace(/check\.yml@[0-9a-f]{40}/, 'check.yml@v2'),
  );
  const currentManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'docs/qualification/gates/workflow-authority.json'),
      'utf8',
    ),
  );
  const refreshed = projectWorkflowAuthority(root, currentManifest).document;
  assert.ok(
    validateWorkflowAuthority(root, refreshed).issues.some((issue) =>
      issue.includes(
        'authority-bearing workflows require immutable external action refs',
      ),
    ),
  );
});

test('refreshing digests cannot give qualification jobs inherited secrets or an Environment', () => {
  const root = fixture();
  const workflow = path.join(root, '.github/workflows/build.yml');
  const original = fs.readFileSync(workflow, 'utf8');
  const currentManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'docs/qualification/gates/workflow-authority.json'),
      'utf8',
    ),
  );

  fs.writeFileSync(
    workflow,
    original.replace(
      / {4}secrets:\n(?: {6}(?:BUILDCHAIN_PROMOTION_TOKEN|BUILDCHAIN_ARTIFACT_RELAY_S3_[A-Z_]+):.*\n){4}/,
      '    secrets: inherit\n',
    ),
  );
  let refreshed = projectWorkflowAuthority(root, currentManifest).document;
  assert.ok(
    validateWorkflowAuthority(root, refreshed).issues.some((issue) =>
      issue.includes('inherited secrets require'),
    ),
  );

  fs.writeFileSync(
    workflow,
    original.replace(
      '    uses: kungfu-systems/buildchain/',
      '    environment: production\n    uses: kungfu-systems/buildchain/',
    ),
  );
  refreshed = projectWorkflowAuthority(root, currentManifest).document;
  assert.ok(
    validateWorkflowAuthority(root, refreshed).issues.some((issue) =>
      issue.includes('Environment access requires'),
    ),
  );
});

test('matrix rendering is deterministic and includes every profile', () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shifu.gates.json'), 'utf8'),
  );
  const executionDocument = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'docs/qualification/gates/execution-profiles.json'),
      'utf8',
    ),
  );
  const matrix = renderPolicyMatrix(registry, executionDocument);
  for (const profile of registry.profiles) {
    assert.match(matrix, new RegExp(profile.id));
  }
  assert.match(matrix, /Execution parameters/);
  assert.match(matrix, /release-candidate/);
});

test('a new Gate requires complete source-bound measurement coverage', () => {
  const root = fixture();
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'shifu.gates.json'), 'utf8'),
  );
  const gate = structuredClone(
    registry.gates.find((item) => item.id === 'layers.release'),
  );
  gate.id = 'governance.measurement-fixture';
  gate.title = 'Measurement fixture';
  gate.summary = 'Proves a new Gate cannot bypass measured evidence.';
  registry.gates.push(gate);
  for (const profile of registry.profiles) {
    profile.decisions[gate.id] = {
      mode: 'off',
      reason: 'Measurement enforcement fixture.',
    };
  }

  assert.ok(
    validateMeasurementCoverage(root, registry).issues.some((issue) =>
      issue.includes(
        'governance.measurement-fixture: measurement record is required',
      ),
    ),
  );
  fs.writeFileSync(
    path.join(root, 'shifu.gates.json'),
    JSON.stringify(registry),
  );
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes(
        'governance.measurement-fixture: measurement record is required',
      ),
    ),
  );

  const receiptRelative =
    'docs/qualification/evidence/fixtures/measurement-fixture.json';
  const receiptPath = path.join(root, receiptRelative);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const definitionDigest = gateDefinitionDigest(gate);
  const sourceSha = 'a'.repeat(40);
  const registryDigest = `sha256:${'b'.repeat(64)}`;
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schema: 'shifu.gate-receipt/v1',
      source: { sha: sourceSha, dirty: false },
      registry: {
        ref: 'shifu.gates.json',
        digest: registryDigest,
        projectId: 'kungfu',
      },
      environment: { platform: 'linux' },
      results: [
        {
          gateId: gate.id,
          definitionDigest,
          attempted: true,
          status: 'pass',
          exitCode: 0,
          durationMs: 17,
        },
      ],
    }),
  );
  const coverage = readMeasurementCoverage(root);
  coverage.measurements.push({
    gateId: gate.id,
    definitionDigest,
    observations: [
      {
        platform: 'linux',
        sourceSha,
        registryDigest,
        durationMs: 17,
        receipt: receiptRelative,
      },
    ],
  });
  writeMeasurementCoverage(root, coverage);
  assert.deepEqual(validateMeasurementCoverage(root, registry).issues, []);
});

test('the frozen unmeasured baseline cannot absorb a new Gate', () => {
  const root = fixture();
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'shifu.gates.json'), 'utf8'),
  );
  const coverage = readMeasurementCoverage(root);
  coverage.baseline.unmeasuredGateIds.push('source.unmeasured-new-gate');
  coverage.baseline.unmeasuredGateIds.sort();
  coverage.baseline.digest = gateDigest(coverage.baseline.unmeasuredGateIds);
  writeMeasurementCoverage(root, coverage);
  assert.ok(
    validateMeasurementCoverage(root, registry).issues.some((issue) =>
      issue.includes(
        'frozen unmeasured baseline changed; new Gates must add measurements',
      ),
    ),
  );
});

test('missing platforms and stale Gate definitions fail measurement coverage', () => {
  const platformRoot = fixture();
  const platformRegistry = JSON.parse(
    fs.readFileSync(path.join(platformRoot, 'shifu.gates.json'), 'utf8'),
  );
  const platformCoverage = readMeasurementCoverage(platformRoot);
  platformCoverage.measurements
    .find((record) => record.gateId === 'gate.catalog')
    .observations.pop();
  writeMeasurementCoverage(platformRoot, platformCoverage);
  assert.ok(
    validateMeasurementCoverage(platformRoot, platformRegistry).issues.some(
      (issue) => issue.includes('gate.catalog: measured platforms'),
    ),
  );

  const staleRoot = fixture();
  const staleRegistry = JSON.parse(
    fs.readFileSync(path.join(staleRoot, 'shifu.gates.json'), 'utf8'),
  );
  const staleCoverage = readMeasurementCoverage(staleRoot);
  staleCoverage.measurements.find(
    (record) => record.gateId === 'gate.catalog',
  ).definitionDigest = `sha256:${'0'.repeat(64)}`;
  writeMeasurementCoverage(staleRoot, staleCoverage);
  assert.ok(
    validateMeasurementCoverage(staleRoot, staleRegistry).issues.some((issue) =>
      issue.includes('gate.catalog: definition digest is stale'),
    ),
  );
  assert.ok(
    !validateMeasurementCoverage(staleRoot, staleRegistry, {
      staleMeasurementGateIds: ['gate.catalog'],
    }).issues.some((issue) =>
      issue.includes('gate.catalog: definition digest is stale'),
    ),
  );
});

test('dirty, unsuccessful, and duration-drifted receipts fail measurement coverage', () => {
  const root = fixture();
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'shifu.gates.json'), 'utf8'),
  );
  const gateCatalog = readMeasurementCoverage(root).measurements.find(
    (record) => record.gateId === 'gate.catalog',
  );
  const receiptPath = path.join(
    root,
    gateCatalog.observations.find(
      (observation) => observation.platform === 'linux',
    ).receipt,
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.source.dirty = true;
  const result = receipt.results.find((item) => item.gateId === 'gate.catalog');
  result.status = 'fail';
  result.exitCode = 1;
  result.durationMs += 1;
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const issues = validateMeasurementCoverage(root, registry).issues;
  assert.ok(
    issues.some((issue) =>
      issue.includes(
        'gate.catalog:linux: receipt must match a clean source SHA',
      ),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes(
        'gate.catalog:linux: receipt result must be an attempted pass',
      ),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes('gate.catalog:linux: durationMs differs from the receipt'),
    ),
  );
});

test('handler Gate measurements require an intact controller binding receipt', () => {
  const root = fixture();
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'shifu.gates.json'), 'utf8'),
  );
  const relative =
    'docs/qualification/evidence/gate-measurements/e978a4c85/linux/governance.dco.controller-receipt.json';
  const receipt = JSON.parse(
    fs.readFileSync(path.join(root, relative), 'utf8'),
  );
  const coverage = readMeasurementCoverage(root);
  coverage.measurements = coverage.measurements.filter(
    (measurement) => measurement.gateId !== receipt.gateId,
  );
  coverage.measurements.push({
    gateId: receipt.gateId,
    definitionDigest: receipt.definitionDigest,
    observations: [
      {
        platform: receipt.environment.platform,
        sourceSha: receipt.source.sha,
        registryDigest: receipt.registry.digest,
        durationMs: receipt.durationMs,
        receipt: relative,
      },
    ],
  });
  writeMeasurementCoverage(root, coverage);
  assert.deepEqual(validateMeasurementCoverage(root, registry).issues, []);

  receipt.binding.adapterDigest = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(path.join(root, relative), JSON.stringify(receipt));
  const issues = validateMeasurementCoverage(root, registry).issues;
  assert.ok(
    issues.some((issue) =>
      issue.includes('controller binding identity is stale'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes('controller receipt integrity is invalid'),
    ),
  );
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
  bindings.bindings[0].gates.push('source.whole-tree');
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  assert.ok(
    checkKungfuGateCatalog(root).issues.some((issue) =>
      issue.includes('dev-pr:source.whole-tree is bound but policy is off'),
    ),
  );
});

test('execution parameter and reuse tuple drift fail closed', () => {
  const root = fixture();
  const profilesPath = path.join(
    root,
    'docs/qualification/gates/execution-profiles.json',
  );
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  profiles.profiles.alpha.budgetSeconds = 0;
  profiles.reusePolicy.keyFields.pop();
  fs.writeFileSync(profilesPath, JSON.stringify(profiles));
  const issues = checkKungfuGateCatalog(root).issues;
  assert.ok(
    issues.some((issue) =>
      issue.includes('alpha.budgetSeconds must be a positive integer'),
    ),
  );
  assert.ok(issues.some((issue) => issue.includes('six unique tuple fields')));
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
      from: 'verify-command: node scripts/run-shifu-lifecycle.mjs cache-apply-command',
      to: 'verify-command: ./shifu verify',
      drift: 'with.verify-command',
    },
    {
      id: 'release-admission',
      workflow: '.github/workflows/release-new-version.yml',
      from: 'required-artifact-count: 5',
      to: 'required-artifact-count: 4',
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
  for (const revision of [
    '9e904de2c85dbea7c799780ee166510b3336d812',
    '0000000000000000000000000000000000000000',
    'v3-alpha',
  ]) {
    const rogueRoot = fixture();
    const uses = `kungfu-systems/buildchain/.github/workflows/.build.yml@${revision}`;
    fs.appendFileSync(
      path.join(
        rogueRoot,
        '.github/workflows/aws-us-macos-burst-qualification.yml',
      ),
      `\n  rogue-qualify:\n    uses: ${uses}\n    with:\n      buildchain-ref: ${revision}\n`,
    );
    assert.ok(
      checkKungfuGateCatalog(rogueRoot).issues.some((issue) =>
        issue.includes(
          `.github/workflows/aws-us-macos-burst-qualification.yml#rogue-qualify:job-uses:${uses}: invocation has no matching binding`,
        ),
      ),
      revision,
    );
  }

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
        '      - name: Validate .buildchain/buildchain.toml\n        uses: kungfu-systems/buildchain/actions/validate-config@v3\n        with:\n          require-version-state: "true"\n          require-lifecycle-stages: "install,check,build,verify"\n      - name: Validate .buildchain/buildchain.toml',
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
        '.gate-profile.yml@916fc84d488ae6f5af271a67487e79ecb47b9ae2',
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
      .replace('runner-preset: custom', 'runner-preset: portable'),
  );
  assert.ok(
    checkKungfuGateCatalog(profileInputRoot).issues.some((issue) =>
      issue.includes(
        '[workflow-profile] dev-heavy-patrol: invocation drift at with.runner-preset',
      ),
    ),
  );

  const profileRuntimeRoot = fixture();
  const profileRuntimeWorkflow = path.join(
    profileRuntimeRoot,
    '.github/workflows/dev-verify-patrol.yml',
  );
  fs.writeFileSync(
    profileRuntimeWorkflow,
    fs
      .readFileSync(profileRuntimeWorkflow, 'utf8')
      .replace(
        "buildchain-ref: ${{ github.event_name == 'workflow_dispatch' && inputs.buildchain-ref || '' }}",
        "buildchain-ref: ${{ inputs.buildchain-ref || '' }}",
      ),
  );
  assert.ok(
    checkKungfuGateCatalog(profileRuntimeRoot).issues.some((issue) =>
      issue.includes(
        '[workflow-profile] dev-heavy-patrol: invocation drift at with.buildchain-ref',
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
  bindings.bindings.find(
    (binding) => binding.id === 'manual-gate-measurement',
  ).currentSource = 'false';
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
  assert.ok(
    issues.some((issue) =>
      issue.includes('manual-gate-measurement: currentSource must be boolean'),
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
