// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  verificationReceipt:
    'docs/shifu/schema/production-graph-verification-receipt-v0.schema.json',
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
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
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
