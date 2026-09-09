// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  verifyAffectedNativePlan,
  verifyAffectedNativeReceipt,
} from '../../scripts/run-core-affected-native.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const CONTRACT_PATH = 'docs/shifu/production-graph-contract.json';

export const SCHEMA_PATHS = Object.freeze({
  graph: 'docs/shifu/schema/production-graph-v0.schema.json',
  plan: 'docs/shifu/schema/production-graph-plan-v0.schema.json',
  executionEvent:
    'docs/shifu/schema/production-graph-execution-event-v0.schema.json',
  receipt: 'docs/shifu/schema/production-graph-receipt-v0.schema.json',
  failure: 'docs/shifu/schema/production-graph-failure-v0.schema.json',
  recovery: 'docs/shifu/schema/production-graph-recovery-v0.schema.json',
  feedback: 'docs/shifu/schema/production-graph-feedback-v0.schema.json',
  verificationReceipt:
    'docs/shifu/schema/production-graph-verification-receipt-v0.schema.json',
  executionAdmissionRequest:
    'docs/shifu/schema/production-graph-execution-admission-request-v0.schema.json',
  executionAdmissionRejection:
    'docs/shifu/schema/production-graph-execution-admission-rejection-v0.schema.json',
  executionAdmissionDecision:
    'docs/shifu/schema/production-graph-execution-admission-decision-v0.schema.json',
  executionAdmissionVerificationReceipt:
    'docs/shifu/schema/production-graph-execution-admission-verification-receipt-v0.schema.json',
  localExecutorPolicy:
    'docs/shifu/schema/production-graph-local-executor-policy-v0.schema.json',
  localExecutionReceipt:
    'docs/shifu/schema/production-graph-local-execution-receipt-v0.schema.json',
  buildCoreShadowReceipt:
    'docs/shifu/schema/build-core-production-graph-shadow-receipt-v0.schema.json',
  buildResult: 'docs/shifu/schema/production-graph-build-result-v0.schema.json',
  buildResultSettlementReceipt:
    'docs/shifu/schema/production-graph-build-result-settlement-receipt-v0.schema.json',
  localCiParityReceipt:
    'docs/shifu/schema/production-graph-local-ci-parity-receipt-v0.schema.json',
  localCiParityReport:
    'docs/shifu/schema/production-graph-local-ci-parity-report-v0.schema.json',
  coreProductionSubgraphCompileRequest:
    'docs/shifu/schema/core-production-subgraph-compile-request-v0.schema.json',
  coreProductionSubgraph:
    'docs/shifu/schema/core-production-subgraph-v0.schema.json',
  coreProductionSubgraphPlan:
    'docs/shifu/schema/core-production-subgraph-plan-v0.schema.json',
  coreProductionSubgraphVerificationReceipt:
    'docs/shifu/schema/core-production-subgraph-verification-receipt-v0.schema.json',
});

const readJson = (root, relative) =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(ordered(value));
}

export function semanticRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

export function rooted(value, field) {
  const body = structuredClone(value);
  delete body[field];
  return { ...body, [field]: semanticRoot(body) };
}

export function fileRoot(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function productionGraphAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) =>
      /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) && Number.isFinite(Date.parse(value)),
  });
  return ajv;
}

export function contractRoot(root = ROOT) {
  return semanticRoot(readJson(root, CONTRACT_PATH));
}

function diagnostic(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function topologicalNodeIds(nodes) {
  const byId = new Map();
  const diagnostics = [];
  for (const node of nodes || []) {
    if (byId.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'duplicate-node',
          `graph.nodes.${node.id}`,
          'node id is repeated',
        ),
      );
    }
    byId.set(node.id, node);
  }
  for (const node of nodes || []) {
    for (const dependency of node.dependencies || []) {
      if (!byId.has(dependency)) {
        diagnostics.push(
          diagnostic(
            'missing-dependency',
            `graph.nodes.${node.id}.dependencies`,
            `unknown dependency ${dependency}`,
          ),
        );
      }
    }
  }
  if (diagnostics.length) return { ids: [], diagnostics };

  const remaining = new Map(
    [...byId].map(([id, node]) => [id, new Set(node.dependencies)]),
  );
  const ids = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length) {
      diagnostics.push(
        diagnostic(
          'dependency-cycle',
          'graph.nodes',
          `dependency cycle among ${[...remaining.keys()].sort().join(', ')}`,
        ),
      );
      break;
    }
    for (const id of ready) {
      ids.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return { ids, diagnostics };
}

function outputRoot(fixtureId, nodeId) {
  return semanticRoot({ fixtureId, nodeId, kind: 'observed-output' });
}

function evidenceRoot(fixtureId, nodeId) {
  return semanticRoot({ fixtureId, nodeId, kind: 'retained-evidence' });
}

export function createPlan(graph) {
  const topology = topologicalNodeIds(graph.nodes);
  if (topology.diagnostics.length) {
    throw new Error(topology.diagnostics.map(({ code }) => code).join(', '));
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return rooted(
    {
      schema: 'shifu.production-graph-plan/v0',
      contractRoot: graph.contractRoot,
      graphRoot: graph.graphRoot,
      sourceRevision: graph.source.revision,
      authorityReferences: graph.authorityReferences,
      xinfaSelectionRoot: graph.semanticImpact.selectionRoot,
      orderedNodeIds: topology.ids,
      steps: topology.ids.map((nodeId, index) => {
        const node = byId.get(nodeId);
        return {
          index,
          nodeId,
          dependsOn: node.dependencies,
          executor: node.executor,
          inputIds: node.inputs.map(({ id }) => id),
          outputIds: node.outputs.map(({ id }) => id),
        };
      }),
    },
    'planRoot',
  );
}

function createFailure(fixture, graph, plan) {
  if (fixture.outcome.status === 'qualified') return null;
  const terminalNodeId = fixture.outcome.terminalNodeId;
  const node = graph.nodes.find(({ id }) => id === terminalNodeId);
  const cancelled = fixture.outcome.status === 'cancelled';
  return rooted(
    {
      schema: 'shifu.production-graph-failure/v0',
      graphRoot: graph.graphRoot,
      planRoot: plan.planRoot,
      nodeId: terminalNodeId,
      classification: cancelled ? 'cancelled' : 'executor-failed',
      owner: node.failure.owner,
      evidenceRoots: [evidenceRoot(fixture.fixtureId, terminalNodeId)],
      recoverable: true,
      nextAction: node.recovery.nextAction,
    },
    'failureRoot',
  );
}

function createRecovery(fixture, graph, plan, failure) {
  if (!failure) return null;
  const node = graph.nodes.find(({ id }) => id === failure.nodeId);
  return rooted(
    {
      schema: 'shifu.production-graph-recovery/v0',
      failureRoot: failure.failureRoot,
      graphRoot: graph.graphRoot,
      planRoot: plan.planRoot,
      strategy: node.recovery.strategy,
      resumeFromNode: node.recovery.strategy === 'stop' ? null : failure.nodeId,
      requiredEvidenceRoots: failure.evidenceRoots,
      eligible: node.recovery.strategy !== 'stop',
      nextAction: node.recovery.nextAction,
    },
    'recoveryRoot',
  );
}

function createEvents(fixture, graph, plan, failure) {
  const events = [];
  const terminalNodeId = fixture.outcome.terminalNodeId || null;
  for (const nodeId of plan.orderedNodeIds) {
    const node = graph.nodes.find(({ id }) => id === nodeId);
    let state = 'succeeded';
    if (nodeId === terminalNodeId) state = fixture.outcome.status;
    events.push(
      rooted(
        {
          schema: 'shifu.production-graph-execution-event/v0',
          graphRoot: graph.graphRoot,
          planRoot: plan.planRoot,
          nodeId,
          sequence: events.length,
          state,
          executor: node.executor,
          sourceRevision: graph.source.revision,
          observedOutputRoots:
            state === 'succeeded'
              ? [outputRoot(fixture.fixtureId, nodeId)]
              : [],
          failureRoot:
            state === 'failed' || state === 'cancelled'
              ? failure.failureRoot
              : null,
        },
        'eventRoot',
      ),
    );
    if (nodeId === terminalNodeId) break;
  }
  return events;
}

export function materializeFixture(fixture, root = ROOT) {
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: fixture.graph.graphId,
      contractRoot: contractRoot(root),
      source: fixture.context.source,
      authorityReferences: fixture.context.authorityReferences,
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: fixture.context.xinfaSelectionRoot,
        otherInputs: [],
      },
      intent: fixture.graph.intent,
      nodes: fixture.graph.nodes,
      nextAction: fixture.graph.nextAction,
    },
    'graphRoot',
  );
  const plan = createPlan(graph);
  const failure = createFailure(fixture, graph, plan);
  const recovery = createRecovery(fixture, graph, plan, failure);
  const events = createEvents(fixture, graph, plan, failure);
  const succeeded = events.filter(({ state }) => state === 'succeeded');
  const receipt = rooted(
    {
      schema: 'shifu.production-graph-receipt/v0',
      status: fixture.outcome.status,
      contractRoot: graph.contractRoot,
      graphRoot: graph.graphRoot,
      planRoot: plan.planRoot,
      sourceRevision: graph.source.revision,
      authorityReferences: graph.authorityReferences,
      xinfaSelectionRoot: graph.semanticImpact.selectionRoot,
      eventRoots: events.map(({ eventRoot }) => eventRoot),
      outputRoots: succeeded.flatMap(
        ({ observedOutputRoots }) => observedOutputRoots,
      ),
      failureRoot: failure?.failureRoot || null,
      recoveryRoot: recovery?.recoveryRoot || null,
      retainedEvidenceRoots: events.map(({ nodeId }) =>
        evidenceRoot(fixture.fixtureId, nodeId),
      ),
      nextAction:
        fixture.outcome.status === 'qualified'
          ? fixture.graph.nextAction
          : recovery.nextAction,
    },
    'receiptRoot',
  );
  return { graph, plan, events, failure, recovery, receipt };
}

function rootDiagnostics(bundle) {
  const diagnostics = [];
  const documents = [
    ['graph', bundle.graph, 'graphRoot'],
    ['plan', bundle.plan, 'planRoot'],
    ...bundle.events.map((event, index) => [
      `events.${index}`,
      event,
      'eventRoot',
    ]),
    ...(bundle.failure ? [['failure', bundle.failure, 'failureRoot']] : []),
    ...(bundle.recovery ? [['recovery', bundle.recovery, 'recoveryRoot']] : []),
    ['receipt', bundle.receipt, 'receiptRoot'],
  ];
  for (const [label, document, field] of documents) {
    if (!document?.[field]) {
      diagnostics.push(
        diagnostic(
          'missing-root',
          `${label}.${field}`,
          'content root is required',
        ),
      );
      continue;
    }
    if (rooted(document, field)[field] !== document[field]) {
      diagnostics.push(
        diagnostic(
          'root-mismatch',
          `${label}.${field}`,
          'content root drifted',
        ),
      );
    }
  }
  return diagnostics;
}

function contextDiagnostics(bundle, expected) {
  const diagnostics = [];
  if (bundle.graph.source.revision !== expected.source.revision) {
    diagnostics.push(
      diagnostic(
        'source-drift',
        'graph.source.revision',
        'source revision drifted',
      ),
    );
  }
  if (!same(bundle.graph.authorityReferences, expected.authorityReferences)) {
    diagnostics.push(
      diagnostic(
        'authority-drift',
        'graph.authorityReferences',
        'project authority roots drifted',
      ),
    );
  }
  if (
    bundle.graph.semanticImpact.selectionRoot !== expected.xinfaSelectionRoot
  ) {
    diagnostics.push(
      diagnostic(
        'xinfa-selection-drift',
        'graph.semanticImpact.selectionRoot',
        'Xinfa selection root drifted',
      ),
    );
  }
  return diagnostics;
}

function relationDiagnostics(bundle) {
  const diagnostics = [];
  const { graph, plan, receipt } = bundle;
  const topology = topologicalNodeIds(graph.nodes);
  diagnostics.push(...topology.diagnostics);
  if (topology.ids.length && !same(plan.orderedNodeIds, topology.ids)) {
    diagnostics.push(
      diagnostic(
        'dependency-order-mismatch',
        'plan.orderedNodeIds',
        'plan order is not the deterministic dependency order',
      ),
    );
  }
  const expectedPlan = topology.ids.length ? createPlan(graph) : null;
  if (expectedPlan && !same(plan, expectedPlan)) {
    diagnostics.push(
      diagnostic(
        'graph-plan-mismatch',
        'plan',
        'plan does not exactly project the graph',
      ),
    );
  }
  const common = [
    ['contractRoot', graph.contractRoot],
    ['graphRoot', graph.graphRoot],
    ['sourceRevision', graph.source.revision],
    ['authorityReferences', graph.authorityReferences],
    ['xinfaSelectionRoot', graph.semanticImpact.selectionRoot],
  ];
  for (const [field, value] of common) {
    if (!same(plan[field], value) && field !== 'contractRoot') {
      diagnostics.push(
        diagnostic(
          'graph-plan-mismatch',
          `plan.${field}`,
          `${field} does not match graph`,
        ),
      );
    }
    if (!same(receipt[field], value)) {
      diagnostics.push(
        diagnostic(
          'plan-receipt-mismatch',
          `receipt.${field}`,
          `${field} does not match graph and plan`,
        ),
      );
    }
  }
  if (receipt.planRoot !== plan.planRoot) {
    diagnostics.push(
      diagnostic(
        'plan-receipt-mismatch',
        'receipt.planRoot',
        'receipt does not bind the exact plan',
      ),
    );
  }
  if (
    !same(
      receipt.eventRoots,
      bundle.events.map(({ eventRoot }) => eventRoot),
    )
  ) {
    diagnostics.push(
      diagnostic(
        'event-receipt-mismatch',
        'receipt.eventRoots',
        'receipt event roots drifted',
      ),
    );
  }
  const nodeIds = new Set(graph.nodes.map(({ id }) => id));
  for (const [index, event] of bundle.events.entries()) {
    if (
      event.graphRoot !== graph.graphRoot ||
      event.planRoot !== plan.planRoot ||
      event.sourceRevision !== graph.source.revision ||
      event.sequence !== index ||
      !nodeIds.has(event.nodeId)
    ) {
      diagnostics.push(
        diagnostic(
          'event-binding-mismatch',
          `events.${index}`,
          'event binding drifted',
        ),
      );
    }
  }
  const terminalFailure = ['failed', 'cancelled'].includes(receipt.status);
  if (terminalFailure) {
    if (
      !bundle.failure ||
      !bundle.recovery ||
      receipt.failureRoot !== bundle.failure.failureRoot ||
      receipt.recoveryRoot !== bundle.recovery.recoveryRoot ||
      bundle.recovery.failureRoot !== bundle.failure.failureRoot ||
      bundle.failure.graphRoot !== graph.graphRoot ||
      bundle.failure.planRoot !== plan.planRoot ||
      bundle.recovery.graphRoot !== graph.graphRoot ||
      bundle.recovery.planRoot !== plan.planRoot
    ) {
      diagnostics.push(
        diagnostic(
          'recovery-binding-mismatch',
          'recovery',
          'failure and recovery roots do not form one exact chain',
        ),
      );
    }
  } else if (
    bundle.failure ||
    bundle.recovery ||
    receipt.failureRoot !== null ||
    receipt.recoveryRoot !== null ||
    bundle.events.some(({ state }) => state !== 'succeeded')
  ) {
    diagnostics.push(
      diagnostic(
        'qualified-outcome-mismatch',
        'receipt.status',
        'qualified receipt contains a non-qualified outcome',
      ),
    );
  }
  return diagnostics;
}

function schemaDiagnostic(kind, error) {
  const missing = error.params?.missingProperty || '';
  let code = 'schema-invalid';
  if (error.keyword === 'additionalProperties') code = 'unknown-field';
  if (error.keyword === 'required') {
    code = /Root$/u.test(missing) ? 'missing-root' : 'missing-field';
  }
  return diagnostic(
    code,
    `${kind}${error.instancePath || ''}${missing ? `/${missing}` : ''}`,
    error.message || 'schema validation failed',
  );
}

export async function schemaValidators(root = ROOT) {
  const ajv = productionGraphAjv();
  const schemas = Object.fromEntries(
    Object.entries(SCHEMA_PATHS).map(([kind, relative]) => [
      kind,
      readJson(root, relative),
    ]),
  );
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return Object.fromEntries(
    Object.entries(schemas).map(([kind, schema]) => [
      kind,
      ajv.getSchema(schema.$id),
    ]),
  );
}

export async function verifyBundle(bundle, expectedContext, options = {}) {
  const validators =
    options.validators || (await schemaValidators(options.root));
  const diagnostics = [];
  const documents = [
    ['graph', bundle.graph],
    ['plan', bundle.plan],
    ...bundle.events.map((event) => ['executionEvent', event]),
    ...(bundle.failure ? [['failure', bundle.failure]] : []),
    ...(bundle.recovery ? [['recovery', bundle.recovery]] : []),
    ['receipt', bundle.receipt],
  ];
  for (const [kind, document] of documents) {
    const validate = validators[kind];
    if (!validate(document)) {
      diagnostics.push(
        ...(validate.errors || []).map((error) =>
          schemaDiagnostic(kind, error),
        ),
      );
    }
  }
  diagnostics.push(...rootDiagnostics(bundle));
  diagnostics.push(...contextDiagnostics(bundle, expectedContext));
  diagnostics.push(...relationDiagnostics(bundle));
  return { valid: diagnostics.length === 0, diagnostics };
}

export function applyFixtureMutation(bundle, context, mutation) {
  const nextBundle = structuredClone(bundle);
  const nextContext = structuredClone(context);
  const root =
    mutation.target === 'context' ? nextContext : nextBundle[mutation.target];
  const pathParts = mutation.path;
  let parent = root;
  for (const part of pathParts.slice(0, -1)) parent = parent[part];
  const key = pathParts.at(-1);
  if (mutation.operation === 'delete') delete parent[key];
  else parent[key] = structuredClone(mutation.value);
  return { bundle: nextBundle, context: nextContext };
}

export function loadProductionGraphContract(root = ROOT) {
  return readJson(root, CONTRACT_PATH);
}

export function loadFixture(root, relative) {
  return readJson(root, relative);
}
const COMPILER_PATH = 'developer/production-graph/compiler/index.mjs';
const SHADOW_RECEIPT_SCHEMA_PATH =
  'docs/shifu/schema/core-affected-production-graph-shadow-receipt-v0.schema.json';
const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});
const REQUIRED_AUTHORITY = 'layers:core-native-qualification';
const CURRENT_TASK = 'core:affected';

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(root, ...args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function observedSource(root) {
  return {
    revision: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

function observedAuthority(root) {
  return Object.fromEntries(
    Object.entries(AUTHORITY_PATHS).map(([kind, relative]) => [
      kind,
      fileRoot(path.join(root, relative)),
    ]),
  );
}

function assertRooted(document, field, label) {
  if (!document?.[field]) throw new Error(`${label} is missing ${field}`);
  if (rooted(document, field)[field] !== document[field]) {
    throw new Error(`${label} ${field} mismatch`);
  }
}

function schemaError(label, validate) {
  return new Error(
    `${label} schema invalid: ${JSON.stringify(validate.errors || [])}`,
  );
}

function assertSchema(label, validate, document) {
  if (!validate(document)) throw schemaError(label, validate);
}

function assertSame(label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

async function inputValidators(root) {
  const ajv = productionGraphAjv();
  for (const relative of Object.values(SCHEMA_PATHS)) {
    ajv.addSchema(readJsonFile(path.join(root, relative)));
  }
  return {
    graph: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-v0.schema.json',
    ),
    plan: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-plan-v0.schema.json',
    ),
    verificationReceipt: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-verification-receipt-v0.schema.json',
    ),
    executionAdmissionRequest: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-execution-admission-request-v0.schema.json',
    ),
    executionAdmissionDecision: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-execution-admission-decision-v0.schema.json',
    ),
    executionAdmissionRejection: ajv.getSchema(
      'https://libkungfu.dev/schemas/shifu/production-graph-execution-admission-rejection-v0.schema.json',
    ),
  };
}

async function shadowReceiptValidator(root) {
  const ajv = productionGraphAjv();
  ajv.addSchema(readJsonFile(path.join(root, SCHEMA_PATHS.graph)));
  const schema = readJsonFile(path.join(root, SHADOW_RECEIPT_SCHEMA_PATH));
  return ajv.compile(schema);
}

export async function verifyProductionGraphShadowInput(
  {
    graph,
    plan,
    verificationReceipt,
    executionAdmissionRequest,
    executionAdmissionDecision,
  },
  {
    root = ROOT,
    trustedVerificationReceipt = verificationReceipt,
    validators = null,
    observedAt = new Date().toISOString(),
  } = {},
) {
  if (!graph) throw new Error('Production Graph input is missing');
  if (!plan) throw new Error('Production Graph plan input is missing');
  if (!verificationReceipt) {
    throw new Error('Production Graph verification receipt is missing');
  }
  if (!executionAdmissionRequest) {
    throw new Error('Production Graph execution admission request is missing');
  }
  if (!executionAdmissionDecision) {
    throw new Error('Production Graph execution admission decision is missing');
  }
  const checks = validators || (await inputValidators(root));
  assertSchema('Production Graph', checks.graph, graph);
  assertSchema('Production Graph plan', checks.plan, plan);
  assertSchema(
    'Production Graph verification receipt',
    checks.verificationReceipt,
    verificationReceipt,
  );
  assertSchema(
    'Production Graph execution admission request',
    checks.executionAdmissionRequest,
    executionAdmissionRequest,
  );
  assertSchema(
    'Production Graph execution admission decision',
    checks.executionAdmissionDecision,
    executionAdmissionDecision,
  );
  assertRooted(graph, 'graphRoot', 'Production Graph');
  assertRooted(plan, 'planRoot', 'Production Graph plan');
  assertRooted(
    verificationReceipt,
    'receiptRoot',
    'Production Graph verification receipt',
  );
  assertRooted(
    executionAdmissionRequest,
    'requestRoot',
    'Production Graph execution admission request',
  );
  assertRooted(
    executionAdmissionDecision,
    'decisionRoot',
    'Production Graph execution admission decision',
  );
  assertSame(
    'Production Graph verification receipt root',
    verificationReceipt,
    trustedVerificationReceipt,
  );

  const source = observedSource(root);
  if (
    graph.source.revision !== source.revision ||
    graph.source.tree !== source.tree
  ) {
    throw new Error('Production Graph source is stale');
  }
  if (
    verificationReceipt.sourceRevision !== source.revision ||
    verificationReceipt.nodesExecuted !== false
  ) {
    throw new Error('Production Graph verification receipt is stale or unsafe');
  }

  const currentContractRoot = contractRoot(root);
  if (
    graph.contractRoot !== currentContractRoot ||
    plan.contractRoot !== currentContractRoot ||
    verificationReceipt.contractRoot !== currentContractRoot
  ) {
    throw new Error('Production Graph contract root mismatch');
  }
  const authority = observedAuthority(root);
  assertSame(
    'Production Graph authority roots',
    graph.authorityReferences,
    authority,
  );
  assertSame(
    'Production Graph plan authority roots',
    plan.authorityReferences,
    authority,
  );
  assertSame(
    'Production Graph verification authority roots',
    verificationReceipt.authorityReferences,
    authority,
  );
  const topology = topologicalNodeIds(graph.nodes);
  if (topology.diagnostics.length) {
    throw new Error(
      `Production Graph dependency invalid: ${topology.diagnostics
        .map(({ code }) => code)
        .join(', ')}`,
    );
  }
  if (
    plan.graphRoot !== graph.graphRoot ||
    plan.sourceRevision !== graph.source.revision ||
    plan.xinfaSelectionRoot !== graph.semanticImpact.selectionRoot
  ) {
    throw new Error('Production Graph plan binding mismatch');
  }
  assertSame('Production Graph compiled plan', plan, createPlan(graph));
  if (graph.nodes.length !== 1 || plan.steps.length !== 1) {
    throw new Error('shadow route authorizes exactly one bounded graph node');
  }
  const node = graph.nodes[0];
  if (
    node.dependencies.length !== 0 ||
    node.executor.entrypoint !== './shifu' ||
    node.executor.task !== CURRENT_TASK ||
    node.executor.executionOwnedBy !== 'external-orchestrator' ||
    node.executor.invokedByVerifier !== false
  ) {
    throw new Error(
      'Production Graph node is unauthorized for the shadow route',
    );
  }
  const authorityRefs = new Set(
    node.authorityRefs.map(({ authority: owner, id }) => `${owner}:${id}`),
  );
  if (!authorityRefs.has(REQUIRED_AUTHORITY)) {
    throw new Error(`Production Graph node is missing ${REQUIRED_AUTHORITY}`);
  }
  if (
    graph.intent.mode !== 'describe-only' ||
    graph.intent.sideEffects !== false
  ) {
    throw new Error('Production Graph intent cannot authorize execution');
  }
  assertSame(
    'Production Graph execution admission graph',
    executionAdmissionRequest.graph,
    graph,
  );
  assertSame(
    'Production Graph execution admission plan',
    executionAdmissionRequest.plan,
    plan,
  );
  const expectedExecutionAdmission = {
    contractRoot: graph.contractRoot,
    graphRoot: graph.graphRoot,
    planRoot: plan.planRoot,
    sourceRevision: graph.source.revision,
    sourceTree: graph.source.tree,
    authorityReferences: graph.authorityReferences,
    xinfaSelectionRoot: graph.semanticImpact.selectionRoot,
    executorPolicyRoot: executionAdmissionRequest.executorPolicyRoot,
  };
  const admissionVerifier = await import('./admission/index.mjs');
  const recomputed = await admissionVerifier.createExecutionAdmissionDecision(
    executionAdmissionRequest,
    { root, expected: expectedExecutionAdmission, validators: checks },
  );
  if (recomputed.decision.status !== 'admitted') {
    throw new Error(
      `Production Graph execution admission rejected: ${recomputed.verification.codes.join(', ')}`,
    );
  }
  assertSame(
    'Production Graph execution admission decision',
    executionAdmissionDecision,
    recomputed.decision,
  );
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error(
      'Production Graph execution admission observation is invalid',
    );
  }
  if (Date.parse(executionAdmissionRequest.observedAt) > observed) {
    throw new Error(
      'Production Graph execution admission observation is in the future',
    );
  }
  if (Date.parse(executionAdmissionDecision.expiresAt) <= observed) {
    throw new Error('Production Graph execution admission is expired');
  }
  if (
    !same(executionAdmissionDecision.intendedNodeIds, plan.orderedNodeIds) ||
    executionAdmissionDecision.nodesStarted !== false ||
    executionAdmissionDecision.authorityMutations.length !== 0
  ) {
    throw new Error('Production Graph execution admission is unsafe');
  }
  return {
    graph,
    plan,
    node,
    verificationReceipt,
    executionAdmissionRequest,
    executionAdmissionDecision,
    compilerRoot: fileRoot(path.join(root, COMPILER_PATH)),
  };
}

function parseArgs(argv) {
  const options = {
    graph: '',
    plan: '',
    verificationReceipt: '',
    executionAdmissionRequest: '',
    executionAdmissionDecision: '',
    outputDir: '',
    execute: false,
    base: '',
    changedFiles: [],
    currentPlanInput: '',
    partitionCount: null,
    partitionIndex: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--graph') options.graph = argv[++index];
    else if (arg === '--plan') options.plan = argv[++index];
    else if (arg === '--verification-receipt') {
      options.verificationReceipt = argv[++index];
    } else if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--execution-admission-request') {
      options.executionAdmissionRequest = argv[++index];
    } else if (arg === '--execution-admission-decision') {
      options.executionAdmissionDecision = argv[++index];
    } else if (arg === '--base') options.base = argv[++index];
    else if (arg === '--changed-file') {
      options.changedFiles.push(argv[++index]);
    } else if (arg === '--current-plan-input') {
      options.currentPlanInput = argv[++index];
    } else if (arg === '--partition-count') {
      options.partitionCount = Number(argv[++index]);
    } else if (arg === '--partition-index') {
      options.partitionIndex = Number(argv[++index]);
    } else if (arg === '--execute') options.execute = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of [
    'graph',
    'plan',
    'verificationReceipt',
    'executionAdmissionRequest',
    'executionAdmissionDecision',
  ]) {
    if (!options[field])
      throw new Error(
        `--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`,
      );
  }
  if (!options.execute) {
    throw new Error('--execute is required for the explicit shadow route');
  }
  return options;
}

function resolveOutputDir(requested, admission, root) {
  const output = path.resolve(
    requested ||
      path.join(
        os.tmpdir(),
        'kungfu-production-graph-shadow',
        admission.graph.source.revision,
        admission.graph.graphRoot.slice(
          'sha256:'.length,
          'sha256:'.length + 16,
        ),
      ),
  );
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('shadow artifacts must use a bounded OS temporary root');
  }
  if (
    output === path.resolve(root) ||
    output.startsWith(`${path.resolve(root)}${path.sep}`)
  ) {
    throw new Error('shadow artifacts cannot be written into the repository');
  }
  return output;
}

function delegateArgs(options, admission, currentPlanPath, currentReceiptPath) {
  const args = [
    CURRENT_TASK,
    '--',
    '--head',
    admission.graph.source.revision,
    '--plan-out',
    currentPlanPath,
    '--receipt',
    currentReceiptPath,
  ];
  if (options.base) args.push('--base', options.base);
  for (const changedFile of options.changedFiles) {
    args.push('--changed-file', changedFile);
  }
  if (options.currentPlanInput) {
    args.push('--plan-input', path.resolve(options.currentPlanInput));
  }
  if (options.partitionCount !== null) {
    args.push('--partition-count', String(options.partitionCount));
  }
  if (options.partitionIndex !== null) {
    args.push('--partition-index', String(options.partitionIndex));
  }
  args.push('--execute');
  return args;
}

async function executeCurrent({ root, args }) {
  const command = path.join(root, 'shifu');
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    return await new Promise((resolve) => {
      child.once('error', (error) =>
        resolve({ exitCode: 1, signal: null, error }),
      );
      child.once('close', (exitCode, signal) =>
        resolve({ exitCode, signal, error: null }),
      );
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

function readOptionalJson(file) {
  return fs.existsSync(file) ? readJsonFile(file) : null;
}

function classifyExecution(result, currentReceipt) {
  const issues = [];
  if (result.error) issues.push(`delegate-error:${result.error.message}`);
  let terminal = 'failed';
  let classification = 'matched-failure';
  if (result.signal) {
    terminal = 'cancelled';
    classification = 'matched-cancellation';
    if (currentReceipt && currentReceipt.status !== 'failed') {
      issues.push('cancelled delegate emitted a non-failed current receipt');
    }
  } else if (result.exitCode === 0) {
    terminal = 'succeeded';
    classification = 'matched-success';
    if (currentReceipt?.status !== 'passed') {
      issues.push('zero exit did not emit a passed current receipt');
    }
  } else if (currentReceipt && currentReceipt.status !== 'failed') {
    issues.push('nonzero exit did not emit a failed current receipt');
  }
  if (!result.signal && !currentReceipt) {
    issues.push('current core:affected receipt is missing');
  }
  return {
    terminal,
    parity: {
      status: issues.length ? 'fail' : 'pass',
      classification: issues.length ? 'drift' : classification,
      issues: [...new Set(issues)].sort(),
    },
  };
}

function createFailureAndRecovery(admission, terminal, evidenceRoots) {
  if (terminal === 'succeeded') return { failure: null, recovery: null };
  const failure = rooted(
    {
      schema: 'shifu.production-graph-failure/v0',
      graphRoot: admission.graph.graphRoot,
      planRoot: admission.plan.planRoot,
      nodeId: admission.node.id,
      classification:
        terminal === 'cancelled' ? 'cancelled' : 'executor-failed',
      owner: admission.node.failure.owner,
      evidenceRoots,
      recoverable: admission.node.recovery.strategy !== 'stop',
      nextAction: admission.node.recovery.nextAction,
    },
    'failureRoot',
  );
  const recovery = rooted(
    {
      schema: 'shifu.production-graph-recovery/v0',
      failureRoot: failure.failureRoot,
      graphRoot: admission.graph.graphRoot,
      planRoot: admission.plan.planRoot,
      strategy: admission.node.recovery.strategy,
      resumeFromNode:
        admission.node.recovery.strategy === 'stop' ? null : admission.node.id,
      requiredEvidenceRoots: evidenceRoots,
      eligible: admission.node.recovery.strategy !== 'stop',
      nextAction: admission.node.recovery.nextAction,
    },
    'recoveryRoot',
  );
  return { failure, recovery };
}

function createEvent(admission, sequence, state, outputRoots, failureRoot) {
  return rooted(
    {
      schema: 'shifu.production-graph-execution-event/v0',
      graphRoot: admission.graph.graphRoot,
      planRoot: admission.plan.planRoot,
      nodeId: admission.node.id,
      sequence,
      state,
      executor: admission.node.executor,
      sourceRevision: admission.graph.source.revision,
      observedOutputRoots: outputRoots,
      failureRoot,
    },
    'eventRoot',
  );
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runProductionGraphShadow(
  options,
  {
    root = ROOT,
    trustedVerificationReceipt = null,
    delegate = executeCurrent,
  } = {},
) {
  const graph = readJsonFile(path.resolve(options.graph));
  const plan = readJsonFile(path.resolve(options.plan));
  const verificationReceipt = readJsonFile(
    path.resolve(options.verificationReceipt),
  );
  const executionAdmissionRequest = readJsonFile(
    path.resolve(options.executionAdmissionRequest),
  );
  const executionAdmissionDecision = readJsonFile(
    path.resolve(options.executionAdmissionDecision),
  );
  let trusted = trustedVerificationReceipt;
  if (!trusted) {
    const verifier = await import('./check.mjs');
    trusted = await verifier.checkProductionGraphContract();
  }
  const admission = await verifyProductionGraphShadowInput(
    {
      graph,
      plan,
      verificationReceipt,
      executionAdmissionRequest,
      executionAdmissionDecision,
    },
    { root, trustedVerificationReceipt: trusted },
  );
  const outputDir = resolveOutputDir(options.outputDir, admission, root);
  fs.mkdirSync(outputDir, { recursive: true });
  const currentPlanPath = path.join(outputDir, 'current-plan.json');
  const currentReceiptPath = path.join(outputDir, 'current-receipt.json');
  const eventsPath = path.join(outputDir, 'events.jsonl');
  const graphReceiptPath = path.join(outputDir, 'graph-receipt.json');
  const failurePath = path.join(outputDir, 'failure.json');
  const recoveryPath = path.join(outputDir, 'recovery.json');
  const shadowReceiptPath = path.join(outputDir, 'shadow-receipt.json');
  const args = delegateArgs(
    options,
    admission,
    currentPlanPath,
    currentReceiptPath,
  );
  const result = await delegate({
    root,
    command: path.join(root, 'shifu'),
    args,
    currentPlanPath,
    currentReceiptPath,
  });
  const currentPlan = readOptionalJson(currentPlanPath);
  const currentReceipt = readOptionalJson(currentReceiptPath);
  const evidenceIssues = [];
  if (!currentPlan)
    evidenceIssues.push('current core:affected plan is missing');
  else {
    try {
      verifyAffectedNativePlan(currentPlan);
    } catch (error) {
      evidenceIssues.push(`current plan invalid:${error.message}`);
    }
  }
  if (currentReceipt) {
    try {
      verifyAffectedNativeReceipt(currentReceipt);
    } catch (error) {
      evidenceIssues.push(`current receipt invalid:${error.message}`);
    }
  }
  const classified = classifyExecution(result, currentReceipt);
  classified.parity.issues.push(...evidenceIssues);
  classified.parity.issues = [...new Set(classified.parity.issues)].sort();
  if (classified.parity.issues.length) {
    classified.parity.status = 'fail';
    classified.parity.classification = 'drift';
  }

  const currentPlanRoot = currentPlan ? semanticRoot(currentPlan) : null;
  const currentReceiptRoot = currentReceipt
    ? semanticRoot(currentReceipt)
    : null;
  const toolchainRoot = currentReceipt?.toolchain
    ? semanticRoot(currentReceipt.toolchain)
    : null;
  const exitEvidenceRoot = semanticRoot({
    command: ['./shifu', ...args],
    exitStatus: result.exitCode,
    signal: result.signal,
  });
  const outputRoots = currentReceiptRoot ? [currentReceiptRoot] : [];
  const evidenceRoots = [
    admission.executionAdmissionRequest.requestRoot,
    admission.executionAdmissionDecision.workRefRoot,
    admission.executionAdmissionDecision.workVerificationRoot,
    ...admission.executionAdmissionDecision.authorizationEvidenceRoots,
    admission.executionAdmissionDecision.authorizationVerificationRoot,
    admission.executionAdmissionDecision.decisionRoot,
    currentPlanRoot,
    currentReceiptRoot,
    toolchainRoot,
    exitEvidenceRoot,
  ].filter(Boolean);
  const chain = createFailureAndRecovery(
    admission,
    classified.terminal,
    evidenceRoots,
  );
  const events = [
    createEvent(admission, 0, 'started', [], null),
    createEvent(
      admission,
      1,
      classified.terminal,
      classified.terminal === 'succeeded' ? outputRoots : [],
      chain.failure?.failureRoot || null,
    ),
  ];
  fs.writeFileSync(
    eventsPath,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const graphReceipt = rooted(
    {
      schema: 'shifu.production-graph-receipt/v0',
      status:
        classified.terminal === 'succeeded' ? 'qualified' : classified.terminal,
      contractRoot: admission.graph.contractRoot,
      graphRoot: admission.graph.graphRoot,
      planRoot: admission.plan.planRoot,
      sourceRevision: admission.graph.source.revision,
      authorityReferences: admission.graph.authorityReferences,
      xinfaSelectionRoot: admission.graph.semanticImpact.selectionRoot,
      eventRoots: events.map(({ eventRoot }) => eventRoot),
      outputRoots,
      failureRoot: chain.failure?.failureRoot || null,
      recoveryRoot: chain.recovery?.recoveryRoot || null,
      retainedEvidenceRoots: evidenceRoots,
      nextAction:
        classified.terminal === 'succeeded'
          ? admission.node.nextAction
          : chain.recovery.nextAction,
    },
    'receiptRoot',
  );
  writeJson(graphReceiptPath, graphReceipt);
  writeJson(failurePath, chain.failure);
  writeJson(recoveryPath, chain.recovery);
  const shadowReceipt = rooted(
    {
      schema: 'kungfu.core-affected-production-graph-shadow-receipt/v0',
      status: graphReceipt.status,
      sourceRevision: admission.graph.source.revision,
      contractRoot: admission.graph.contractRoot,
      compilerRoot: admission.compilerRoot,
      verifierRoot: admission.verificationReceipt.verifierRoot,
      verificationReceiptRoot: admission.verificationReceipt.receiptRoot,
      executionAdmissionRequestRoot:
        admission.executionAdmissionRequest.requestRoot,
      executionAdmissionDecisionRoot:
        admission.executionAdmissionDecision.decisionRoot,
      workRefRoot: admission.executionAdmissionDecision.workRefRoot,
      workVerificationRoot:
        admission.executionAdmissionDecision.workVerificationRoot,
      authorizationEvidenceRoots:
        admission.executionAdmissionDecision.authorizationEvidenceRoots,
      authorizationVerificationRoot:
        admission.executionAdmissionDecision.authorizationVerificationRoot,
      executionAdmissionExpiresAt:
        admission.executionAdmissionDecision.expiresAt,
      graphRoot: admission.graph.graphRoot,
      graphPlanRoot: admission.plan.planRoot,
      xinfaSelectionRoot: admission.graph.semanticImpact.selectionRoot,
      currentPlanRoot,
      toolchainRoot,
      eventRoots: graphReceipt.eventRoots,
      outputRoots,
      currentReceiptRoot,
      graphReceiptRoot: graphReceipt.receiptRoot,
      exitStatus: result.exitCode,
      signal: result.signal,
      parity: classified.parity,
      artifacts: {
        executionAdmissionRequest: path.resolve(
          options.executionAdmissionRequest,
        ),
        executionAdmissionDecision: path.resolve(
          options.executionAdmissionDecision,
        ),
        events: eventsPath,
        graphReceipt: graphReceiptPath,
        currentPlan: currentPlanPath,
        currentReceipt: currentReceiptPath,
        failure: failurePath,
        recovery: recoveryPath,
      },
    },
    'receiptRoot',
  );
  const validateShadowReceipt = await shadowReceiptValidator(root);
  assertSchema(
    'Production Graph shadow receipt',
    validateShadowReceipt,
    shadowReceipt,
  );
  writeJson(shadowReceiptPath, shadowReceipt);
  return { shadowReceipt, graphReceipt, events, shadowReceiptPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runProductionGraphShadow(options);
  console.log(
    `[core-affected-graph-shadow] receipt=${result.shadowReceiptPath}`,
  );
  const exitStatus = result.shadowReceipt.exitStatus;
  if (result.shadowReceipt.parity.status !== 'pass') process.exitCode = 1;
  else if (result.shadowReceipt.signal) {
    process.exitCode =
      128 + (os.constants.signals[result.shadowReceipt.signal] || 0);
  } else if (exitStatus !== 0) process.exitCode = exitStatus || 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[core-affected-graph-shadow] ${error.message}`);
    process.exitCode = 1;
  });
}
