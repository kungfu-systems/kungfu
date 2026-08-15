// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiagnosticsArtifact } from '@kungfu-tech/buildchain-alpha/diagnostics';

import { createExecutionAdmissionDecision } from '../framework/production-graph/admission/index.mjs';
import {
  checkProductionGraphContract,
  materializeExecutionAdmissionFixture,
} from '../framework/production-graph/check.mjs';
import {
  contractRoot,
  createPlan,
  fileRoot,
  rooted,
  semanticRoot,
} from '../framework/production-graph/contract.mjs';
import {
  runProductionGraphShadow,
  verifyProductionGraphShadowInput,
} from '../framework/production-graph/contract.mjs';
import { observeNativeToolchain } from './affected-native-proof.mjs';
import {
  affectedNativeWorkflowSdkProjection,
  changedPathsBetween,
  devQueueQualificationImpact,
  planFromChanged,
  sdkQualificationImpact,
} from './run-core-affected-native.mjs';

test('affected-native planning retains deleted source paths', () => {
  let observedArgs = [];
  const changed = changedPathsBetween('base', 'head', (...args) => {
    observedArgs = args;
    return 'deleted.cpp\nmodified.cpp\n';
  });

  assert.deepEqual(observedArgs, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACDMRTUXB',
    'base...head',
  ]);
  assert.deepEqual(changed, ['deleted.cpp', 'modified.cpp']);
});

const workflowPath = '.github/workflows/affected-native-pr.yml';
const architecture = JSON.parse(
  fs.readFileSync(
    new URL('../framework/core/architecture/layers.json', import.meta.url),
  ),
);
const buildAuthority = JSON.parse(
  fs.readFileSync(
    new URL(
      '../framework/core/architecture/build-capabilities.json',
      import.meta.url,
    ),
  ),
);

test('affected-native pins the configurable fnm bootstrap mirror and digest', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/affected-native-pr.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /KUNGFU_FNM_DIST_MIRROR: \$\{\{ vars\.KUNGFU_FNM_DIST_MIRROR \}\}/u,
  );
  assert.match(
    workflow,
    /KUNGFU_FNM_SHA256: \$\{\{ vars\.KUNGFU_FNM_SHA256 \}\}/u,
  );
});

test('affected-native diagnostics accepts the declarative signing contract', () => {
  const diagnostics = createDiagnosticsArtifact({ cwd: process.cwd() });
  const [cliArtifact] =
    diagnostics.buildchain.config.validation.signing.artifacts;
  assert.equal(cliArtifact.entitlementsProfile, 'jit-executable-v1');
  assert.deepEqual(cliArtifact.entitlementsPaths, [
    'kungfu-episodes-cli-darwin-arm64/runtime/kungfu',
    'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3',
    'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3.13',
  ]);
});

function affectedNativeWorkflowFixture() {
  return {
    permissions: { contents: 'read', actions: 'read' },
    jobs: {
      candidate_preflight: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 10,
        needs: 'candidate_buildchain_config',
        outputs: {
          'sdk-required': '${{ steps.plan.outputs.sdk-required }}',
        },
        steps: [
          {
            name: 'Plan exact dev candidate qualification',
            id: 'plan',
            run: 'node scripts/run-core-affected-native.mjs --json',
          },
          { name: 'Upload candidate preflight plan', uses: 'actions/upload' },
        ],
      },
      affected_native_shards: {
        needs: ['candidate_preflight', 'proof_probe'],
        if: '${{ needs.candidate_preflight.outputs.sdk-required }}',
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 75,
        strategy: { matrix: { partition: [0, 1] } },
        env: { CC: 'gcc-14', CXX: 'g++-14' },
        steps: [
          { uses: 'actions/checkout@v4' },
          { name: 'Build Core SDK artifacts', run: './shifu build:core:sdk' },
          {
            name: 'Qualify installed four-language SDK wire contract',
            run: './shifu layers:qualify:sdk',
          },
          { name: 'Run affected native closure', run: './shifu gate run' },
        ],
      },
    },
  };
}

function workflowImpact(before, after) {
  return sdkQualificationImpact(
    ['.github/workflows/affected-native-pr.yml'],
    'base',
    'head',
    {
      workflowAtRevision: (revision) => (revision === 'base' ? before : after),
    },
  );
}

test('dev queue impact keeps unrelated source changes out of optional heavy gates', () => {
  assert.deepEqual(devQueueQualificationImpact(['framework/gui/src/app.ts']), {
    shifuWorkspace: { required: false, reasons: [] },
    kfdVerifier: { required: false, reasons: [] },
  });
});

test('Qualified Core native consumer changes require the platform matrix', () => {
  for (const file of [
    'framework/agent-session/src/runtime-port.mjs',
    'framework/agent-session/tests/runtime-port.native-peer.mjs',
    'framework/agent-session/tests/runtime-port.native.test.mjs',
    '.github/actions/qualified-core-candidate-build/action.yml',
    'product/scripts/verify-cli-surface-qualification.mjs',
  ]) {
    const plan = planFromChanged(
      [file],
      architecture,
      buildAuthority,
      'base',
      'head',
    );
    assert.equal(plan.closureComponents.length, architecture.components.length);
    assert.notEqual(plan.platformTier, 'none');
  }
});

test('dev queue impact selects Shifu and KFD from their declared source surfaces', () => {
  const impact = devQueueQualificationImpact([
    'docs/development/buildchain.md',
    'crates/xinfa/src/lib.rs',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.deepEqual(
    impact.shifuWorkspace.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs', 'docs/development/buildchain.md'],
  );
  assert.equal(impact.kfdVerifier.required, true);
  assert.deepEqual(
    impact.kfdVerifier.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs'],
  );
});

test('the SDK build plan is a self-qualifying SDK authority input', () => {
  assert.deepEqual(
    sdkQualificationImpact(
      ['framework/core/architecture/sdk-build-plan.json'],
      'base',
      'head',
    ),
    {
      required: true,
      reasons: [
        {
          path: 'framework/core/architecture/sdk-build-plan.json',
          kind: 'sdk-authority-or-input',
        },
      ],
    },
  );
});

test('the staged workflow remains self-qualifying under both moved gates', () => {
  const impact = devQueueQualificationImpact([
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.equal(impact.kfdVerifier.required, true);
  assert.deepEqual(
    impact.shifuWorkspace.reasons.map(({ path }) => path),
    [
      '.github/workflows/affected-native-cache-promote.yml',
      '.github/workflows/affected-native-pr.yml',
    ],
  );
});

test('affected-native SDK projection excludes scheduling needs and unrelated jobs', () => {
  const before = affectedNativeWorkflowFixture();
  const after = structuredClone(before);
  after.jobs.affected_native_shards.needs.push('source_acceptance');
  after.jobs.affected_native_shards.if =
    "${{ needs.source_acceptance.result == 'success' && needs.candidate_preflight.outputs.sdk-required }}";
  after.jobs.cancel_after_source_failure = {
    needs: 'source_acceptance',
    'runs-on': 'ubuntu-24.04',
    steps: [{ run: 'gh api --method POST /cancel' }],
  };

  assert.deepEqual(
    affectedNativeWorkflowSdkProjection(before),
    affectedNativeWorkflowSdkProjection(after),
  );
  assert.deepEqual(workflowImpact(before, after), {
    required: false,
    reasons: [
      {
        path: workflowPath,
        kind: 'affected-native-workflow-sdk-neutral',
      },
    ],
  });
});

test('affected-native SDK projection preserves execution and qualification changes', () => {
  const mutations = [
    (workflow) => {
      workflow.jobs.candidate_preflight.steps[0].run += ' --changed';
    },
    (workflow) => {
      workflow.jobs.candidate_preflight.needs = 'another_preflight';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.needs = ['candidate_preflight'];
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.if =
        '${{ needs.candidate_preflight.outputs.native-required }}';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards['runs-on'] = 'ubuntu-22.04';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.steps[1].run += ' --changed';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.steps[2].run += ' --changed';
    },
  ];
  for (const mutate of mutations) {
    const before = affectedNativeWorkflowFixture();
    const after = structuredClone(before);
    mutate(after);
    assert.equal(workflowImpact(before, after).required, true);
    assert.equal(
      workflowImpact(before, after).reasons[0].kind,
      'affected-native-workflow-sdk-projection',
    );
  }
});

test('affected-native SDK projection fails closed when its boundary is missing', () => {
  const before = affectedNativeWorkflowFixture();
  const after = structuredClone(before);
  after.jobs.affected_native_shards.steps.splice(2, 1);
  assert.deepEqual(workflowImpact(before, after), {
    required: true,
    reasons: [
      {
        path: workflowPath,
        kind: 'affected-native-workflow-sdk-impact-unknown',
      },
    ],
  });
});

const shadowRoot = path.resolve(new URL('..', import.meta.url).pathname);
const shadowArchitecturePath = path.join(
  shadowRoot,
  'framework/core/architecture/layers.json',
);
const shadowBuildCapabilitiesPath = path.join(
  shadowRoot,
  'framework/core/architecture/build-capabilities.json',
);

function shadowGit(...args) {
  const { status, stdout, stderr } = spawnSync('git', args, {
    cwd: shadowRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

function productionGraphShadowFixture() {
  const source = {
    repository: 'https://github.com/kungfu-origin/kungfu.git',
    revision: shadowGit('rev-parse', 'HEAD'),
    tree: shadowGit('rev-parse', 'HEAD^{tree}'),
  };
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: 'core-affected-shadow-slice',
      contractRoot: contractRoot(shadowRoot),
      source,
      authorityReferences: {
        layers: fileRoot(shadowArchitecturePath),
        buildCapabilities: fileRoot(shadowBuildCapabilitiesPath),
      },
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: semanticRoot({ source, route: 'core-affected-shadow' }),
        otherInputs: [],
      },
      intent: {
        mode: 'describe-only',
        summary: 'Describe one bounded Core affected shadow slice.',
        requestedOutputs: ['core-affected-native-receipt'],
        sideEffects: false,
      },
      nodes: [
        {
          id: 'core-affected-shadow',
          authorityRefs: [
            { authority: 'layers', id: 'core-native-qualification' },
            { authority: 'build-capabilities', id: 'full' },
          ],
          dependencies: [],
          executor: {
            entrypoint: './shifu',
            task: 'core:affected',
            executionOwnedBy: 'external-orchestrator',
            invokedByVerifier: false,
          },
          inputs: [
            {
              id: 'xinfa-selection',
              kind: 'evidence',
              root: semanticRoot({ source, selection: 'verified' }),
            },
          ],
          outputs: [
            {
              id: 'core-affected-native-receipt',
              kind: 'evidence',
              root: null,
            },
          ],
          events: ['planned', 'started', 'succeeded', 'failed', 'cancelled'],
          exit: {
            successCodes: [0],
            timeoutSeconds: 4500,
            failureIsNonQualifying: true,
            cancellationIsNonQualifying: true,
          },
          failure: {
            owner: 'core-native-qualification',
            retainedEvidence: ['core-affected-native-raw-logs'],
          },
          recovery: {
            strategy: 'replan',
            nextAction: 'Retain current evidence and compile a fresh graph.',
          },
          nextAction: 'Compare the graph and current Core receipts.',
        },
      ],
      nextAction: 'Hand the shadow receipt to the external orchestrator.',
    },
    'graphRoot',
  );
  return { graph, plan: createPlan(graph) };
}

async function shadowExecutionAdmission(graph, plan) {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(
        shadowRoot,
        'docs/shifu/examples/production-graph/admission/admitted.fixture.json',
      ),
      'utf8',
    ),
  );
  const observed = Date.now();
  const spec = {
    ...fixture.request,
    observedAt: new Date(observed - 1000).toISOString(),
    issuedAt: new Date(observed - 60_000).toISOString(),
    leaseExpiresAt: new Date(observed + 3_600_000).toISOString(),
    authorizationExpiresAt: new Date(observed + 1_800_000).toISOString(),
  };
  const request = materializeExecutionAdmissionFixture(graph, plan, spec);
  const { decision } = await createExecutionAdmissionDecision(request, {
    root: shadowRoot,
  });
  assert.equal(decision.status, 'admitted');
  return { request, decision };
}

function shadowCurrentPlan() {
  const head = shadowGit('rev-parse', 'HEAD');
  return planFromChanged(
    ['framework/core/CMakeLists.txt'],
    architecture,
    buildAuthority,
    head,
    head,
  );
}

function writeShadowJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function shadowDiskFixture(t) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'core-affected-graph-shadow-test-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { graph, plan } = productionGraphShadowFixture();
  const verificationReceipt = await checkProductionGraphContract();
  const executionAdmission = await shadowExecutionAdmission(graph, plan);
  const graphPath = path.join(temporary, 'graph.json');
  const planPath = path.join(temporary, 'plan.json');
  const verificationPath = path.join(temporary, 'verification.json');
  const executionAdmissionRequestPath = path.join(
    temporary,
    'execution-admission-request.json',
  );
  const executionAdmissionDecisionPath = path.join(
    temporary,
    'execution-admission-decision.json',
  );
  writeShadowJson(graphPath, graph);
  writeShadowJson(planPath, plan);
  writeShadowJson(verificationPath, verificationReceipt);
  writeShadowJson(executionAdmissionRequestPath, executionAdmission.request);
  writeShadowJson(executionAdmissionDecisionPath, executionAdmission.decision);
  return {
    temporary,
    graph,
    plan,
    verificationReceipt,
    executionAdmission,
    options: {
      graph: graphPath,
      plan: planPath,
      verificationReceipt: verificationPath,
      executionAdmissionRequest: executionAdmissionRequestPath,
      executionAdmissionDecision: executionAdmissionDecisionPath,
      outputDir: path.join(temporary, 'output'),
      execute: true,
      base: '',
      changedFiles: ['framework/core/CMakeLists.txt'],
      currentPlanInput: '',
      partitionCount: null,
      partitionIndex: null,
    },
  };
}

test('graph shadow admission binds exact plan, source, authority, and verifier', async () => {
  const { graph, plan } = productionGraphShadowFixture();
  const verificationReceipt = await checkProductionGraphContract();
  const executionAdmission = await shadowExecutionAdmission(graph, plan);
  const admission = await verifyProductionGraphShadowInput(
    {
      graph,
      plan,
      verificationReceipt,
      executionAdmissionRequest: executionAdmission.request,
      executionAdmissionDecision: executionAdmission.decision,
    },
    {
      root: shadowRoot,
      trustedVerificationReceipt: verificationReceipt,
    },
  );
  assert.equal(admission.node.executor.task, 'core:affected');
  assert.match(admission.compilerRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('standalone execution admission verifies the live checkout cut', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const result = spawnSync(
    process.execPath,
    [
      'framework/production-graph/admission/index.mjs',
      '--request',
      fixture.options.executionAdmissionRequest,
    ],
    { cwd: shadowRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision.status, 'admitted');
  assert.equal(output.decision.nodesStarted, false);
  assert.deepEqual(output.decision.authorityMutations, []);
});

test('graph shadow rejects missing, stale, mismatched, cyclic, and unauthorized inputs', async () => {
  const base = productionGraphShadowFixture();
  const verificationReceipt = await checkProductionGraphContract();
  const executionAdmission = await shadowExecutionAdmission(
    base.graph,
    base.plan,
  );
  const rejects = async (mutate, pattern) => {
    const fixture = structuredClone({
      ...base,
      verificationReceipt,
      executionAdmissionRequest: executionAdmission.request,
      executionAdmissionDecision: executionAdmission.decision,
    });
    mutate(fixture);
    await assert.rejects(
      verifyProductionGraphShadowInput(fixture, {
        root: shadowRoot,
        trustedVerificationReceipt: verificationReceipt,
      }),
      pattern,
    );
  };

  await rejects((fixture) => {
    Reflect.deleteProperty(fixture.graph, 'graphRoot');
  }, /schema invalid|missing graphRoot/u);
  await rejects((fixture) => {
    fixture.graph.source.revision = '1'.repeat(40);
    fixture.graph = rooted(fixture.graph, 'graphRoot');
    fixture.plan = createPlan(fixture.graph);
  }, /source is stale/u);
  await rejects((fixture) => {
    fixture.plan.sourceRevision = '2'.repeat(40);
    fixture.plan = rooted(fixture.plan, 'planRoot');
  }, /plan binding mismatch/u);
  await rejects((fixture) => {
    fixture.graph.nodes[0].dependencies = ['core-affected-shadow'];
    fixture.graph = rooted(fixture.graph, 'graphRoot');
  }, /dependency invalid: dependency-cycle/u);
  await rejects((fixture) => {
    fixture.graph.nodes[0].executor.task = 'build';
    fixture.graph = rooted(fixture.graph, 'graphRoot');
    fixture.plan = createPlan(fixture.graph);
  }, /unauthorized/u);
  await rejects((fixture) => {
    fixture.verificationReceipt.verifierRoot = `sha256:${'f'.repeat(64)}`;
    fixture.verificationReceipt = rooted(
      fixture.verificationReceipt,
      'receiptRoot',
    );
  }, /verification receipt root mismatch/u);
  await assert.rejects(
    verifyProductionGraphShadowInput(
      {
        ...base,
        verificationReceipt: null,
        executionAdmissionRequest: executionAdmission.request,
        executionAdmissionDecision: executionAdmission.decision,
      },
      {
        root: shadowRoot,
        trustedVerificationReceipt: verificationReceipt,
      },
    ),
    /verification receipt is missing/u,
  );
});

test('every execution-admission rejection starts zero graph nodes', async (t) => {
  const mutations = [
    (request) => Reflect.deleteProperty(request, 'work'),
    (request) => Reflect.deleteProperty(request, 'authorization'),
    (request) => {
      request.work.status = 'stale';
    },
    (request) => {
      request.graph.source.revision = '7'.repeat(40);
    },
    (request) => {
      request.authorization.expiresAt = new Date(
        Date.parse(request.observedAt) - 1,
      ).toISOString();
    },
    (request) => {
      request.authorization.actor = 'different-actor';
    },
    (request) => {
      request.authorization.intendedNodeIds = ['different-node'];
    },
    (request) => {
      request.authorization.replayState = 'consumed';
    },
    (request) => {
      request.authorization.decision = 'denied';
    },
    (request) => {
      request.authorization.status = 'stale';
    },
    (request) => {
      request.authorization.authority = 'shifu.production-graph';
    },
  ];
  for (const mutate of mutations) {
    const fixture = await shadowDiskFixture(t);
    const request = structuredClone(fixture.executionAdmission.request);
    mutate(request);
    if (request.graph?.graphRoot)
      request.graph = rooted(request.graph, 'graphRoot');
    if (request.work?.verificationRoot) {
      request.work = rooted(request.work, 'verificationRoot');
    }
    if (request.authorization?.verificationRoot) {
      request.authorization = rooted(request.authorization, 'verificationRoot');
    }
    const changed = rooted(request, 'requestRoot');
    writeShadowJson(fixture.options.executionAdmissionRequest, changed);
    let delegated = 0;
    await assert.rejects(
      runProductionGraphShadow(fixture.options, {
        root: shadowRoot,
        trustedVerificationReceipt: fixture.verificationReceipt,
        delegate: async () => {
          delegated += 1;
          return { exitCode: 0, signal: null, error: null };
        },
      }),
      /execution admission|schema invalid/u,
    );
    assert.equal(delegated, 0);
  }
});

test('graph shadow success delegates unchanged and binds current evidence', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const delegated = [];
  const result = await runProductionGraphShadow(fixture.options, {
    root: shadowRoot,
    trustedVerificationReceipt: fixture.verificationReceipt,
    delegate: async (invocation) => {
      delegated.push(invocation);
      const plan = shadowCurrentPlan();
      writeShadowJson(invocation.currentPlanPath, plan);
      writeShadowJson(invocation.currentReceiptPath, {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan,
        planDigest: plan.planDigest,
        toolchain: { compiler: 'fixture', runner: 'node-test' },
      });
      return { exitCode: 0, signal: null, error: null };
    },
  });
  assert.deepEqual(delegated[0].args.slice(0, 2), ['core:affected', '--']);
  assert.ok(delegated[0].args.includes('--execute'));
  assert.equal(result.shadowReceipt.status, 'qualified');
  assert.deepEqual(result.shadowReceipt.parity, {
    status: 'pass',
    classification: 'matched-success',
    issues: [],
  });
  assert.match(result.shadowReceipt.currentPlanRoot, /^sha256:/u);
  assert.match(result.shadowReceipt.currentReceiptRoot, /^sha256:/u);
  assert.match(result.shadowReceipt.toolchainRoot, /^sha256:/u);
  assert.equal(result.events[1].state, 'succeeded');
});

test('graph feedback CLI preserves artifacts and keeps human and JSON facts aligned', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const result = await runProductionGraphShadow(fixture.options, {
    root: shadowRoot,
    trustedVerificationReceipt: fixture.verificationReceipt,
    delegate: async (invocation) => {
      const plan = shadowCurrentPlan();
      writeShadowJson(invocation.currentPlanPath, plan);
      writeShadowJson(invocation.currentReceiptPath, {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan,
        planDigest: plan.planDigest,
        toolchain: observeNativeToolchain(),
        privatePayload: 'DO_NOT_RENDER',
      });
      return { exitCode: 0, signal: null, error: null };
    },
  });
  const outputFiles = fs.readdirSync(fixture.options.outputDir).sort();
  const before = Object.fromEntries(
    outputFiles.map((name) => [
      name,
      fileRoot(path.join(fixture.options.outputDir, name)),
    ]),
  );
  const baseArgs = [
    'framework/production-graph/feedback/index.mjs',
    '--graph',
    fixture.options.graph,
    '--plan',
    fixture.options.plan,
    '--shadow-receipt',
    result.shadowReceiptPath,
  ];
  const jsonResult = spawnSync(process.execPath, [...baseArgs, '--json'], {
    cwd: shadowRoot,
    encoding: 'utf8',
  });
  assert.equal(
    jsonResult.status,
    0,
    `${jsonResult.stderr}\n${jsonResult.stdout}`,
  );
  const feedback = JSON.parse(jsonResult.stdout);
  assert.equal(feedback.state, 'complete');
  assert.equal(feedback.sideEffects, false);
  assert.equal(
    feedback.receipts.shadowReceiptRoot,
    result.shadowReceipt.receiptRoot,
  );
  assert.equal(jsonResult.stdout.includes('DO_NOT_RENDER'), false);

  const humanResult = spawnSync(process.execPath, baseArgs, {
    cwd: shadowRoot,
    encoding: 'utf8',
  });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  for (const value of [
    feedback.state,
    feedback.source.revision,
    feedback.graph.graphRoot,
    feedback.parity.classification,
    feedback.nextAction,
  ]) {
    assert.ok(humanResult.stdout.includes(String(value)), `missing ${value}`);
  }
  assert.equal(humanResult.stdout.includes('DO_NOT_RENDER'), false);
  const afterFiles = fs.readdirSync(fixture.options.outputDir).sort();
  const after = Object.fromEntries(
    afterFiles.map((name) => [
      name,
      fileRoot(path.join(fixture.options.outputDir, name)),
    ]),
  );
  assert.deepEqual(afterFiles, outputFiles);
  assert.deepEqual(after, before);
});

test('graph shadow default verifier resolves the trusted receipt before admission', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const result = await runProductionGraphShadow(fixture.options, {
    root: shadowRoot,
    delegate: async (invocation) => {
      const plan = shadowCurrentPlan();
      writeShadowJson(invocation.currentPlanPath, plan);
      writeShadowJson(invocation.currentReceiptPath, {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan,
        planDigest: plan.planDigest,
        toolchain: { compiler: 'fixture', runner: 'node-test' },
      });
      return { exitCode: 0, signal: null, error: null };
    },
  });
  assert.equal(result.shadowReceipt.parity.classification, 'matched-success');
});

test('graph shadow preserves nonzero current failure and its receipt', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const result = await runProductionGraphShadow(fixture.options, {
    root: shadowRoot,
    trustedVerificationReceipt: fixture.verificationReceipt,
    delegate: async (invocation) => {
      const plan = shadowCurrentPlan();
      writeShadowJson(invocation.currentPlanPath, plan);
      writeShadowJson(invocation.currentReceiptPath, {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'failed',
        plan,
        planDigest: plan.planDigest,
        toolchain: { compiler: 'fixture', runner: 'node-test' },
      });
      return { exitCode: 7, signal: null, error: null };
    },
  });
  assert.equal(result.shadowReceipt.status, 'failed');
  assert.equal(result.shadowReceipt.exitStatus, 7);
  assert.deepEqual(result.shadowReceipt.parity, {
    status: 'pass',
    classification: 'matched-failure',
    issues: [],
  });
  assert.equal(result.events[1].state, 'failed');
  assert.match(result.graphReceipt.failureRoot, /^sha256:/u);
  assert.match(result.graphReceipt.recoveryRoot, /^sha256:/u);
});

test('graph shadow preserves cancellation without inventing a receipt', async (t) => {
  const fixture = await shadowDiskFixture(t);
  const result = await runProductionGraphShadow(fixture.options, {
    root: shadowRoot,
    trustedVerificationReceipt: fixture.verificationReceipt,
    delegate: async (invocation) => {
      writeShadowJson(invocation.currentPlanPath, shadowCurrentPlan());
      return { exitCode: null, signal: 'SIGTERM', error: null };
    },
  });
  assert.equal(result.shadowReceipt.status, 'cancelled');
  assert.equal(result.shadowReceipt.currentReceiptRoot, null);
  assert.deepEqual(result.shadowReceipt.parity, {
    status: 'pass',
    classification: 'matched-cancellation',
    issues: [],
  });
  assert.equal(result.events[1].state, 'cancelled');
});
