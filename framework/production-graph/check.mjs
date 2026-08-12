#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createExecutionAdmissionDecision } from './admission/index.mjs';
import {
  SCHEMA_PATHS,
  applyFixtureMutation,
  contractRoot,
  fileRoot,
  loadFixture,
  loadProductionGraphContract,
  materializeFixture,
  rooted,
  schemaValidators,
  semanticRoot,
  verifyBundle,
} from './contract.mjs';
import { checkCoreProductionSubgraphContract } from './core-subgraph/index.mjs';
import { checkBuildResultContract } from './result-projection/index.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const FIXTURE_ROOT = 'docs/shifu/examples/production-graph';
const INVALID_ROOT = `${FIXTURE_ROOT}/invalid`;
const ADMISSION_ROOT = `${FIXTURE_ROOT}/admission`;
const ADMISSION_INVALID_ROOT = `${ADMISSION_ROOT}/invalid`;

function fixtureFiles(relativeRoot) {
  return fs
    .readdirSync(path.join(ROOT, relativeRoot))
    .filter((name) => name.endsWith('.fixture.json'))
    .sort()
    .map((name) => `${relativeRoot}/${name}`);
}

// Conformance-fixture materialization only. These synthetic envelopes carry no
// Assignment, Work Control, Warrant, approval, merge, close, or execution
// authority.
export function materializeExecutionAdmissionFixture(graph, plan, spec) {
  const workRef = {
    schema: 'kungfu.work-ref/v1',
    workspaceId: spec.workspaceId,
    profileId: spec.profileId,
    profileRoot: spec.profileRoot,
    entityType: 'assignment',
    entityId: spec.assignmentId,
    initiativeId: spec.initiativeId,
    entityRoot: spec.assignmentRequestRoot,
    purpose: 'complete-project-assignment',
    systemTimeCut: spec.queryProofRoot,
  };
  const executionClaimRoot = spec.executionClaimRoot;
  const work = rooted(
    {
      authority: 'kungfu.work-control',
      status: 'verified',
      phase: 'executing',
      workRef,
      workRefRoot: semanticRoot(workRef),
      assignmentRequestRoot: spec.assignmentRequestRoot,
      workDefinitionRoot: spec.workDefinitionRoot,
      assignmentStateRoot: spec.assignmentStateRoot,
      queryProofRoot: spec.queryProofRoot,
      executionClaimRoot,
      runGateRoot: spec.runGateRoot,
      attemptId: spec.attemptId,
      actor: spec.actor,
      leaseExpiresAt: spec.leaseExpiresAt,
    },
    'verificationRoot',
  );
  const authorization = rooted(
    {
      authority: spec.authorizationAuthority || 'kungfu.warrant',
      status: 'verified',
      decision: 'allowed',
      action: 'start-production-graph-nodes',
      actor: spec.actor,
      attemptId: spec.attemptId,
      executorPolicyRoot: spec.executorPolicyRoot,
      intendedNodeIds: plan.orderedNodeIds,
      issuedAt: spec.issuedAt,
      expiresAt: spec.authorizationExpiresAt,
      replayState: 'fresh',
      evidence: [
        { kind: 'execution-claim', root: executionClaimRoot },
        { kind: 'warrant', root: spec.warrantRoot },
      ],
    },
    'verificationRoot',
  );
  return rooted(
    {
      schema: 'shifu.production-graph-execution-admission-request/v0',
      requestId: spec.requestId,
      graph,
      plan,
      executorPolicyRoot: spec.executorPolicyRoot,
      work,
      authorization,
      actor: spec.actor,
      attemptId: spec.attemptId,
      intendedNodeIds: plan.orderedNodeIds,
      observedAt: spec.observedAt,
    },
    'requestRoot',
  );
}

function verifyContractBoundary(contract) {
  assert.equal(contract.schema, 'shifu.production-graph-contract/v0');
  assert.deepEqual(contract.schemas, SCHEMA_PATHS);
  assert.equal(contract.verification.command, './shifu check:production-graph');
  assert.equal(contract.verification.protectedGate, './shifu check:source');
  assert.equal(contract.verification.executesNodes, false);
  assert.equal(
    contract.executionAdmission.command,
    './shifu production-graph:admit',
  );
  assert.equal(contract.executionAdmission.requiredBeforeNodeStart, true);
  assert.equal(contract.executionAdmission.failClosed, true);
  assert.equal(contract.executionAdmission.nodesStartedByAdmission, false);
  assert.equal(contract.executionAdmission.authorityMutations, false);
  assert.deepEqual(contract.executionAdmission.authorizationAuthorities, [
    'kungfu.work-control',
    'kungfu.warrant',
    'external-approval-authority',
  ]);
  assert.deepEqual(contract.executionAdmission.shifuForbiddenAuthority, [
    'mint-assignment',
    'mutate-assignment',
    'mint-work-control',
    'mutate-work-control',
    'mint-warrant',
    'mutate-warrant',
    'mint-approval',
    'mutate-approval',
    'mint-merge-authority',
    'mutate-merge-authority',
    'mint-close-authority',
    'mutate-close-authority',
  ]);
  assert.equal(
    contract.localExecutor.command,
    './shifu production-graph:execute',
  );
  assert.equal(contract.localExecutor.concurrency, 1);
  assert.equal(contract.localExecutor.fixtureSafeOnly, false);
  assert.deepEqual(contract.localExecutor.boundedRealTasks, [
    'build:core',
    'core-production-subgraph:dependency-bootstrap',
    'core-production-subgraph:native-build',
    'core-production-subgraph:artifact-stage',
  ]);
  assert.deepEqual(contract.localExecutor.boundedTaskEnvironment, {
    'build:core': { KUNGFU_BUILD_PROFILE: 'journal' },
    'core-production-subgraph:dependency-bootstrap': {
      KUNGFU_BUILD_PROFILE: 'journal',
    },
    'core-production-subgraph:native-build': {
      KUNGFU_BUILD_PROFILE: 'journal',
    },
    'core-production-subgraph:artifact-stage': {
      KUNGFU_BUILD_PROFILE: 'journal',
    },
  });
  assert.equal(contract.localExecutor.requiresExactAdmission, true);
  assert.equal(contract.localExecutor.replayStartsNodes, false);
  assert.equal(
    contract.localCiParity.command,
    './shifu production-graph:local-ci-parity',
  );
  assert.deepEqual(contract.localCiParity.platforms, ['ubuntu']);
  assert.equal(contract.localCiParity.conformanceAdmissionOnly, true);
  assert.equal(contract.localCiParity.authority, 'additive-shadow-only');
  assert.equal(contract.localCiParity.approvalAuthority, false);
  assert.equal(contract.localCiParity.mergeAuthority, false);
  assert.equal(contract.localCiParity.publishingAuthority, false);
  assert.equal(contract.localCiParity.releaseAuthority, false);
  assert.equal(contract.localCiParity.weakensChecks, false);
  assert.equal(contract.localExecutor.schedulerAuthority, false);
  assert.equal(contract.localExecutor.workAuthorityMutations, false);
  assert.equal(
    contract.buildCoreShadow.command,
    './shifu build:core:graph-shadow',
  );
  assert.equal(
    contract.buildCoreShadow.authoritativeCommand,
    './shifu build:core',
  );
  assert.equal(contract.buildCoreShadow.profile, 'journal');
  assert.equal(contract.buildCoreShadow.cutover, false);
  assert.deepEqual(contract.coreProductionSubgraph.orderedNodes, [
    'dependency-bootstrap',
    'native-build',
    'artifact-stage',
  ]);
  assert.equal(
    contract.coreProductionSubgraph.authoritativeCommand,
    './shifu build:core',
  );
  assert.equal(contract.coreProductionSubgraph.stagesDirectlyInvocable, false);
  assert.equal(contract.coreProductionSubgraph.describeOnly, true);
  assert.equal(contract.coreProductionSubgraph.cutover, false);
  assert.equal(contract.nativeBuildLoweringExploration.profile, 'journal');
  assert.equal(contract.nativeBuildLoweringExploration.node, 'native-build');
  assert.equal(contract.nativeBuildLoweringExploration.backend, 'bazel');
  assert.equal(
    contract.nativeBuildLoweringExploration.verdict,
    'conditional-go',
  );
  assert.equal(contract.nativeBuildLoweringExploration.fixtureOnly, true);
  assert.equal(contract.nativeBuildLoweringExploration.executable, false);
  assert.equal(contract.nativeBuildLoweringExploration.writesBuildFiles, false);
  assert.equal(contract.nativeBuildLoweringExploration.invokesBackend, false);
  assert.equal(contract.nativeBuildLoweringExploration.nodesExecuted, false);
  assert.equal(
    contract.nativeBuildLoweringExploration.authoritativeCommand,
    './shifu build:core',
  );
  assert.equal(contract.nativeBuildLoweringExploration.cutover, false);
  assert.equal(
    contract.coreProductionSubgraph.stageExecutor,
    './shifu core-production-subgraph:execute',
  );
  assert.equal(
    contract.coreProductionSubgraph.stageExecutorAuthority,
    'additive-admitted-shadow-only',
  );
  assert.equal(contract.coreProductionSubgraph.stageExecutorConcurrency, 1);
  assert.equal(
    contract.buildResult.command,
    './shifu production-graph:build-result',
  );
  assert.equal(contract.buildResult.authority, 'projection-only');
  for (const field of [
    'canonicalCutAuthority',
    'buildchainEvidenceAuthority',
    'kfdAuthority',
    'artifactStorageAuthority',
    'publishingAuthority',
    'signingAuthority',
    'releaseCutAuthority',
  ]) {
    assert.equal(contract.buildResult[field], false, field);
  }
  assert.equal(contract.feedback.command, './shifu production-graph:feedback');
  assert.equal(contract.feedback.sideEffects, false);
  assert.equal(contract.feedback.executesRecovery, false);
  assert.deepEqual(contract.feedback.exitCodes, {
    0: 'complete',
    1: 'bounded-human-action-required',
    2: 'blocked-by-drift',
    3: 'invalid-command-or-input',
  });
  assert.equal(contract.authorityReferences.semanticImpactOwner, 'xinfa');
  assert.equal(
    contract.authorityReferences.semanticImpactInput,
    'graph.semanticImpact.selectionRoot',
  );
  assert.deepEqual(contract.authorityBoundary.forbiddenOperations, [
    'capture',
    'claim',
    'dispatch',
    'schedule',
    'approve',
    'merge',
    'close',
  ]);
}

function verifierRoot() {
  return semanticRoot(
    [
      'framework/production-graph/contract.mjs',
      'framework/production-graph/compiler/index.mjs',
      'framework/production-graph/check.mjs',
      'framework/production-graph/check.test.mjs',
      'framework/production-graph/feedback/index.mjs',
      'framework/production-graph/admission/index.mjs',
      'framework/production-graph/executor/index.mjs',
      'framework/production-graph/executor/index.test.mjs',
      'framework/production-graph/shadow-build-core/index.mjs',
      'framework/production-graph/shadow-build-core/index.test.mjs',
      'framework/production-graph/result-projection/index.mjs',
      'framework/production-graph/result-projection/index.test.mjs',
      'framework/production-graph/local-ci-parity/index.mjs',
      'framework/production-graph/local-ci-parity/index.test.mjs',
      'docs/shifu/examples/production-graph/result-projection/cancellation.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/failure.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/partial-output.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/success.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/invalid/completeness-mismatch.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/invalid/execution-receipt-drift.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/invalid/missing-digest.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/invalid/settlement-receipt-mismatch.fixture.json',
      'docs/shifu/examples/production-graph/result-projection/invalid/source-drift.fixture.json',
      'framework/production-graph/compiler/polyglot.fixture.mjs',
      'framework/production-graph/core-subgraph/index.mjs',
      'framework/production-graph/core-subgraph/index.test.mjs',
      'framework/production-graph/core-subgraph/stage-executor/index.mjs',
      'docs/shifu/core-production-subgraph-contract.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/journal.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/dependency-edge.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/input-root.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/output-root.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/project-authority-root.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/responsibility.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/source-root.fixture.json',
      'docs/shifu/examples/production-graph/core-production-subgraph/invalid/xinfa-root.fixture.json',
    ].map((relative) => ({
      path: relative,
      root: fileRoot(path.join(ROOT, relative)),
    })),
  );
}

function executionAdmissionExpected(request) {
  return {
    contractRoot: request.graph.contractRoot,
    graphRoot: request.graph.graphRoot,
    planRoot: request.plan.planRoot,
    sourceRevision: request.graph.source.revision,
    sourceTree: request.graph.source.tree,
    authorityReferences: request.graph.authorityReferences,
    xinfaSelectionRoot: request.graph.semanticImpact.selectionRoot,
    executorPolicyRoot: request.executorPolicyRoot,
  };
}

function mutateAdmission(request, expected, mutation) {
  const documents = {
    request: structuredClone(request),
    expected: structuredClone(expected),
  };
  let parent = documents[mutation.target];
  for (const key of mutation.path.slice(0, -1)) parent = parent[key];
  const key = mutation.path.at(-1);
  if (mutation.operation === 'delete') delete parent[key];
  else parent[key] = structuredClone(mutation.value);
  return documents;
}

export async function checkExecutionAdmissionContract(
  graph,
  plan,
  { validators = null, sourceRevision = null } = {},
) {
  const checks = validators || (await schemaValidators(ROOT));
  const fixture = loadFixture(ROOT, `${ADMISSION_ROOT}/admitted.fixture.json`);
  const request = materializeExecutionAdmissionFixture(
    graph,
    plan,
    fixture.request,
  );
  const expected = executionAdmissionExpected(request);
  const admitted = await createExecutionAdmissionDecision(request, {
    root: ROOT,
    expected,
    validators: checks,
  });
  assert.equal(admitted.verification.valid, true);
  assert.equal(admitted.decision.status, 'admitted');
  assert.equal(admitted.decision.nodesStarted, false);
  assert.deepEqual(admitted.decision.authorityMutations, []);

  const rejectedDecisionRoots = [];
  const rejectionCodes = new Set();
  for (const relative of fixtureFiles(ADMISSION_INVALID_ROOT)) {
    const invalid = loadFixture(ROOT, relative);
    const changed = mutateAdmission(request, expected, invalid.mutation);
    const rejected = await createExecutionAdmissionDecision(changed.request, {
      root: ROOT,
      expected: changed.expected,
      validators: checks,
    });
    assert.equal(rejected.decision.status, 'rejected', relative);
    assert.equal(rejected.decision.nodesStarted, false, relative);
    assert.deepEqual(rejected.decision.authorityMutations, [], relative);
    assert.ok(rejected.rejection, `${relative}: rejection is missing`);
    assert.equal(rejected.rejection.nodesStarted, false, relative);
    assert.deepEqual(rejected.rejection.authorityMutations, [], relative);
    assert.ok(
      rejected.verification.codes.includes(invalid.expect),
      `${relative}: expected ${invalid.expect}, got ${JSON.stringify(rejected.verification.codes)}`,
    );
    rejectedDecisionRoots.push(rejected.decision.decisionRoot);
    rejectionCodes.add(invalid.expect);
  }
  assert.ok(rejectedDecisionRoots.length >= 8);
  assert.ok(rejectionCodes.size >= 8);

  const receipt = rooted(
    {
      schema:
        'shifu.production-graph-execution-admission-verification-receipt/v0',
      status: 'qualified',
      sourceRevision: sourceRevision || graph.source.revision,
      contractRoot: graph.contractRoot,
      schemaRoots: {
        request: semanticRoot(
          loadFixture(ROOT, SCHEMA_PATHS.executionAdmissionRequest),
        ),
        decision: semanticRoot(
          loadFixture(ROOT, SCHEMA_PATHS.executionAdmissionDecision),
        ),
        rejection: semanticRoot(
          loadFixture(ROOT, SCHEMA_PATHS.executionAdmissionRejection),
        ),
        verificationReceipt: semanticRoot(
          loadFixture(ROOT, SCHEMA_PATHS.executionAdmissionVerificationReceipt),
        ),
      },
      verifierRoot: semanticRoot(
        [
          'framework/production-graph/admission/index.mjs',
          `${ADMISSION_ROOT}/admitted.fixture.json`,
          ...fixtureFiles(ADMISSION_INVALID_ROOT),
        ].map((relative) => ({
          path: relative,
          root: fileRoot(path.join(ROOT, relative)),
        })),
      ),
      admittedDecisionRoots: [admitted.decision.decisionRoot],
      rejectedDecisionRoots,
      rejectionCodes: [...rejectionCodes].sort(),
      protectedGate: './shifu check:source',
      nodesStarted: false,
      authorityMutations: [],
    },
    'receiptRoot',
  );
  assert.equal(
    checks.executionAdmissionVerificationReceipt(receipt),
    true,
    JSON.stringify(checks.executionAdmissionVerificationReceipt.errors),
  );
  return receipt;
}

export async function checkProductionGraphContract() {
  const contract = loadProductionGraphContract(ROOT);
  verifyContractBoundary(contract);
  const validators = await schemaValidators(ROOT);
  const validFiles = fixtureFiles(FIXTURE_ROOT);
  const invalidFiles = fixtureFiles(INVALID_ROOT);
  assert.equal(
    validFiles.length,
    3,
    'exactly three valid outcome fixtures are required',
  );
  assert.ok(
    invalidFiles.length >= 7,
    'at least seven negative fixtures are required',
  );

  const fixtureSources = validFiles.map((relative) => ({
    relative,
    fixture: loadFixture(ROOT, relative),
  }));
  const sourceById = new Map(
    fixtureSources.map(({ fixture }) => [fixture.fixtureId, fixture]),
  );
  const valid = new Map();
  for (const { relative, fixture: sourceFixture } of fixtureSources) {
    const inherited = sourceFixture.graphFixture
      ? sourceById.get(sourceFixture.graphFixture)
      : null;
    assert.ok(
      !sourceFixture.graphFixture || inherited,
      `${relative}: unknown graph fixture ${sourceFixture.graphFixture}`,
    );
    const fixture = {
      ...sourceFixture,
      context: sourceFixture.context || inherited?.context,
      graph: sourceFixture.graph || inherited?.graph,
    };
    const bundle = materializeFixture(fixture, ROOT);
    const result = await verifyBundle(bundle, fixture.context, {
      root: ROOT,
      validators,
    });
    assert.equal(
      result.valid,
      true,
      `${relative}: ${JSON.stringify(result.diagnostics)}`,
    );
    valid.set(fixture.fixtureId, { fixture, bundle });
  }

  const qualified = valid.get('qualified');
  assert.ok(qualified, 'qualified fixture is required for execution admission');

  await checkBuildResultContract({ validators });

  for (const relative of invalidFiles) {
    const fixture = loadFixture(ROOT, relative);
    const base = valid.get(fixture.baseFixture);
    assert.ok(base, `${relative}: unknown base fixture ${fixture.baseFixture}`);
    const mutated = applyFixtureMutation(
      base.bundle,
      base.fixture.context,
      fixture.mutation,
    );
    const result = await verifyBundle(mutated.bundle, mutated.context, {
      root: ROOT,
      validators,
    });
    assert.equal(result.valid, false, `${relative}: negative fixture passed`);
    assert.ok(
      result.diagnostics.some(({ code }) => code === fixture.expect),
      `${relative}: expected ${fixture.expect}, got ${JSON.stringify(result.diagnostics)}`,
    );
  }

  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const executionAdmissionReceipt = await checkExecutionAdmissionContract(
    qualified.bundle.graph,
    qualified.bundle.plan,
    { validators, sourceRevision },
  );
  const coreProductionSubgraphReceipt =
    await checkCoreProductionSubgraphContract({ validators });
  const receipt = rooted(
    {
      schema: 'shifu.production-graph-verification-receipt/v0',
      status: 'qualified',
      sourceRevision,
      contractRoot: contractRoot(ROOT),
      schemaRoots: Object.fromEntries(
        Object.entries(SCHEMA_PATHS).map(([kind, relative]) => [
          kind,
          semanticRoot(loadFixture(ROOT, relative)),
        ]),
      ),
      authorityReferences: {
        layers: fileRoot(path.join(ROOT, contract.authorityReferences.layers)),
        buildCapabilities: fileRoot(
          path.join(ROOT, contract.authorityReferences.buildCapabilities),
        ),
      },
      verifierRoot: verifierRoot(),
      validFixtureRoots: [...valid.values()].map(
        ({ bundle }) => bundle.receipt.receiptRoot,
      ),
      validFixtureCount: validFiles.length,
      invalidFixtureCount: invalidFiles.length,
      executionAdmissionReceiptRoot: executionAdmissionReceipt.receiptRoot,
      coreProductionSubgraphReceiptRoot:
        coreProductionSubgraphReceipt.receiptRoot,
      protectedGate: './shifu check:source',
      nodesExecuted: false,
    },
    'receiptRoot',
  );
  const validateReceipt = validators.verificationReceipt;
  assert.equal(
    validateReceipt(receipt),
    true,
    JSON.stringify(validateReceipt.errors),
  );
  return receipt;
}

async function main() {
  console.log(JSON.stringify(await checkProductionGraphContract(), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
