#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { observeNativeToolchain } from '../../../scripts/affected-native-proof.mjs';
import {
  verifyAffectedNativePlan,
  verifyAffectedNativeReceipt,
} from '../../../scripts/run-core-affected-native.mjs';
import {
  canonicalJson,
  createPlan,
  fileRoot,
  rooted,
  semanticRoot,
  verifyBundle,
} from '../contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});

const diagnostic = (code, pathValue, message) => ({
  code,
  path: pathValue,
  message,
});

function uniqueDiagnostics(values) {
  const seen = new Set();
  return values
    .filter(({ code, path: pathValue, message }) => {
      const key = canonicalJson({ code, path: pathValue, message });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.path.localeCompare(right.path),
    );
}

function checkRoot(document, field, pathValue, diagnostics) {
  if (!document) {
    diagnostics.push(
      diagnostic('missing-evidence', pathValue, `${pathValue} is missing`),
    );
    return false;
  }
  if (!document[field]) {
    diagnostics.push(
      diagnostic(
        'missing-evidence',
        `${pathValue}.${field}`,
        `${field} is missing`,
      ),
    );
    return false;
  }
  if (rooted(document, field)[field] !== document[field]) {
    diagnostics.push(
      diagnostic('root-mismatch', `${pathValue}.${field}`, `${field} drifted`),
    );
    return false;
  }
  return true;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function observedProjectContext(projectRoot) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
  return {
    source: {
      revision: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
    },
    authorityReferences: Object.fromEntries(
      Object.entries(AUTHORITY_PATHS).map(([kind, relative]) => [
        kind,
        fileRoot(path.join(projectRoot, relative)),
      ]),
    ),
    toolchainRoot: semanticRoot(observeNativeToolchain()),
  };
}

function verifyCurrentEvidence(input, diagnostics) {
  if (input.currentPlan) {
    try {
      verifyAffectedNativePlan(input.currentPlan);
    } catch (error) {
      diagnostics.push(diagnostic('plan-drift', 'currentPlan', error.message));
    }
  }
  if (input.currentReceipt) {
    try {
      verifyAffectedNativeReceipt(input.currentReceipt);
    } catch (error) {
      diagnostics.push(
        diagnostic('retained-output-drift', 'currentReceipt', error.message),
      );
    }
  }
}

function shadowDiagnostics(input, observed, diagnostics) {
  const {
    graph,
    plan,
    events,
    receipt,
    failure,
    recovery,
    shadowReceipt,
    currentPlan,
    currentReceipt,
  } = input;
  if (
    observed.source &&
    (observed.source.revision !== graph.source.revision ||
      observed.source.tree !== graph.source.tree)
  ) {
    diagnostics.push(
      diagnostic(
        'source-drift',
        'graph.source',
        'source revision or tree drifted',
      ),
    );
  }
  checkRoot(shadowReceipt, 'receiptRoot', 'shadowReceipt', diagnostics);
  if (
    shadowReceipt.sourceRevision !== graph.source.revision ||
    shadowReceipt.contractRoot !== graph.contractRoot
  ) {
    diagnostics.push(
      diagnostic(
        'graph-drift',
        'shadowReceipt',
        'shadow source or contract root drifted',
      ),
    );
  }
  if (!same(shadowReceipt.graphRoot, graph.graphRoot)) {
    diagnostics.push(
      diagnostic(
        'graph-drift',
        'shadowReceipt.graphRoot',
        'shadow graph root drifted',
      ),
    );
  }
  if (!same(shadowReceipt.graphPlanRoot, plan.planRoot)) {
    diagnostics.push(
      diagnostic(
        'plan-drift',
        'shadowReceipt.graphPlanRoot',
        'shadow plan root drifted',
      ),
    );
  }
  if (!same(shadowReceipt.graphReceiptRoot, receipt.receiptRoot)) {
    diagnostics.push(
      diagnostic(
        'retained-output-drift',
        'shadowReceipt.graphReceiptRoot',
        'graph receipt root drifted',
      ),
    );
  }
  if (shadowReceipt.status !== receipt.status) {
    diagnostics.push(
      diagnostic(
        'retained-output-drift',
        'shadowReceipt.status',
        'receipt status drifted',
      ),
    );
  }
  if (
    !same(shadowReceipt.xinfaSelectionRoot, graph.semanticImpact.selectionRoot)
  ) {
    diagnostics.push(
      diagnostic(
        'xinfa-selection-drift',
        'shadowReceipt.xinfaSelectionRoot',
        'Xinfa selection root drifted',
      ),
    );
  }
  if (
    !same(
      shadowReceipt.eventRoots,
      events.map(({ eventRoot }) => eventRoot),
    )
  ) {
    diagnostics.push(
      diagnostic(
        'retained-output-drift',
        'shadowReceipt.eventRoots',
        'event roots drifted',
      ),
    );
  }
  if (!same(shadowReceipt.outputRoots, receipt.outputRoots)) {
    diagnostics.push(
      diagnostic(
        'retained-output-drift',
        'shadowReceipt.outputRoots',
        'output roots drifted',
      ),
    );
  }
  const currentPlanRoot = currentPlan ? semanticRoot(currentPlan) : null;
  const currentReceiptRoot = currentReceipt
    ? semanticRoot(currentReceipt)
    : null;
  const retainedToolchainRoot = currentReceipt?.toolchain
    ? semanticRoot(currentReceipt.toolchain)
    : null;
  if (
    currentPlan &&
    currentReceipt?.plan &&
    !same(currentPlan, currentReceipt.plan)
  ) {
    diagnostics.push(
      diagnostic(
        'plan-drift',
        'currentReceipt.plan',
        'current receipt does not bind the retained current plan',
      ),
    );
  }
  for (const [field, actual] of [
    ['currentPlanRoot', currentPlanRoot],
    ['currentReceiptRoot', currentReceiptRoot],
    ['toolchainRoot', retainedToolchainRoot],
  ]) {
    if (!same(shadowReceipt[field], actual)) {
      diagnostics.push(
        diagnostic(
          'retained-output-drift',
          `shadowReceipt.${field}`,
          `${field} does not match retained evidence`,
        ),
      );
    }
  }
  if (
    observed.toolchainRoot &&
    shadowReceipt.toolchainRoot &&
    observed.toolchainRoot !== shadowReceipt.toolchainRoot
  ) {
    diagnostics.push(
      diagnostic(
        'toolchain-drift',
        'shadowReceipt.toolchainRoot',
        'toolchain root drifted',
      ),
    );
  }
  const retainedRoots = new Set(receipt.retainedEvidenceRoots || []);
  for (const [field, value] of [
    ['currentPlanRoot', shadowReceipt.currentPlanRoot],
    ['currentReceiptRoot', shadowReceipt.currentReceiptRoot],
    ['toolchainRoot', shadowReceipt.toolchainRoot],
  ]) {
    if (value && !retainedRoots.has(value)) {
      diagnostics.push(
        diagnostic(
          'retained-output-drift',
          `receipt.retainedEvidenceRoots.${field}`,
          `${field} is not retained by the graph receipt`,
        ),
      );
    }
  }
  for (const value of recovery?.requiredEvidenceRoots || []) {
    if (!retainedRoots.has(value)) {
      diagnostics.push(
        diagnostic(
          'retained-output-drift',
          'recovery.requiredEvidenceRoots',
          'recovery requires evidence not retained by the graph receipt',
        ),
      );
    }
  }
  if (shadowReceipt.parity.status !== 'pass') {
    diagnostics.push(
      diagnostic(
        'parity-drift',
        'shadowReceipt.parity',
        'current and graph outcomes diverged',
      ),
    );
  }
  if (receipt.status !== 'qualified') {
    if (!failure) {
      diagnostics.push(
        diagnostic(
          'missing-evidence',
          'failure',
          'failure evidence is missing',
        ),
      );
    }
    if (!recovery) {
      diagnostics.push(
        diagnostic(
          'missing-evidence',
          'recovery',
          'recovery evidence is missing',
        ),
      );
    }
  }
}

function selectDecision(input, diagnostics) {
  const drift = diagnostics.some(({ code }) =>
    /(?:drift|mismatch)$/u.test(code),
  );
  if (drift) {
    return {
      state: 'blocked-by-drift',
      exitCode: 2,
      externallyBlocked: true,
      nextAction:
        'Preserve the receipts and compile a fresh source-bound graph before any recovery.',
    };
  }
  if (diagnostics.length) {
    return {
      state: 'inspect',
      exitCode: 1,
      externallyBlocked: true,
      nextAction:
        'Preserve the receipts and ask the external owner to inspect or supply the missing evidence.',
    };
  }
  if (input.receipt.status === 'qualified') {
    return {
      state: 'complete',
      exitCode: 0,
      externallyBlocked: false,
      nextAction: input.receipt.nextAction,
    };
  }
  if (input.receipt.status === 'cancelled') {
    return {
      state: 'restart-required',
      exitCode: 1,
      externallyBlocked: false,
      nextAction: input.recovery.nextAction,
    };
  }
  if (!input.recovery?.eligible || input.recovery?.strategy === 'stop') {
    return {
      state: 'inspect',
      exitCode: 1,
      externallyBlocked: true,
      nextAction: input.recovery?.nextAction || input.receipt.nextAction,
    };
  }
  if (input.recovery.strategy === 'retry-node') {
    return {
      state: 'resume-eligible',
      exitCode: 1,
      externallyBlocked: false,
      nextAction: input.recovery.nextAction,
    };
  }
  return {
    state: 'restart-required',
    exitCode: 1,
    externallyBlocked: false,
    nextAction: input.recovery.nextAction,
  };
}

export async function createProductionGraphFeedback(
  input,
  { observed = {}, verifyCurrent = false, root = ROOT } = {},
) {
  const diagnostics = [];
  for (const [label, document, field] of [
    ['graph', input.graph, 'graphRoot'],
    ['plan', input.plan, 'planRoot'],
    ...input.events.map((event, index) => [
      `events.${index}`,
      event,
      'eventRoot',
    ]),
    ['receipt', input.receipt, 'receiptRoot'],
    ...(input.failure ? [['failure', input.failure, 'failureRoot']] : []),
    ...(input.recovery ? [['recovery', input.recovery, 'recoveryRoot']] : []),
  ]) {
    checkRoot(document, field, label, diagnostics);
  }
  try {
    const verification = await verifyBundle(
      {
        graph: input.graph,
        plan: input.plan,
        events: input.events,
        failure: input.failure,
        recovery: input.recovery,
        receipt: input.receipt,
      },
      {
        source: observed.source || input.graph.source,
        authorityReferences:
          observed.authorityReferences || input.graph.authorityReferences,
        xinfaSelectionRoot:
          observed.xinfaSelectionRoot ||
          input.graph.semanticImpact.selectionRoot,
      },
      { root },
    );
    diagnostics.push(
      ...verification.diagnostics.filter(({ code }) => {
        if (
          code === 'recovery-binding-mismatch' &&
          (!input.failure || !input.recovery)
        ) {
          return false;
        }
        if (code === 'event-receipt-mismatch' && input.events.length === 0) {
          return false;
        }
        if (
          code === 'qualified-outcome-mismatch' &&
          input.receipt.status === 'qualified' &&
          !input.failure &&
          !input.recovery &&
          input.events.every(({ state }) =>
            ['started', 'succeeded'].includes(state),
          )
        ) {
          return false;
        }
        return true;
      }),
    );
  } catch (error) {
    diagnostics.push(
      diagnostic('schema-invalid', 'feedbackInput', error.message),
    );
  }
  try {
    if (!same(input.plan, createPlan(input.graph))) {
      diagnostics.push(
        diagnostic(
          'plan-drift',
          'plan',
          'plan is not the exact graph projection',
        ),
      );
    }
  } catch (error) {
    diagnostics.push(diagnostic('plan-drift', 'plan', error.message));
  }
  shadowDiagnostics(input, observed, diagnostics);
  if (verifyCurrent) verifyCurrentEvidence(input, diagnostics);
  const exactDiagnostics = uniqueDiagnostics(diagnostics);
  const decision = selectDecision(input, exactDiagnostics);
  const nodeEvents = new Map();
  for (const event of input.events) {
    const values = nodeEvents.get(event.nodeId) || [];
    values.push(event);
    nodeEvents.set(event.nodeId, values);
  }
  const feedback = {
    schema: 'shifu.production-graph-feedback/v0',
    state: decision.state,
    exitCode: decision.exitCode,
    sideEffects: false,
    source: input.graph.source,
    graph: {
      id: input.graph.graphId,
      contractRoot: input.graph.contractRoot,
      graphRoot: input.graph.graphRoot,
      planRoot: input.plan.planRoot,
      authorityReferences: input.graph.authorityReferences,
      xinfaSelectionRoot: input.graph.semanticImpact.selectionRoot,
    },
    nodes: input.graph.nodes.map((node) => {
      const events = nodeEvents.get(node.id) || [];
      return {
        id: node.id,
        state: events.at(-1)?.state || 'planned',
        executor: node.executor,
        inputRoots: node.inputs.map(({ id, kind, root: inputRoot }) => ({
          id,
          kind,
          root: inputRoot,
        })),
        eventRoots: events.map(({ eventRoot }) => eventRoot),
        outputRoots: events.flatMap(
          ({ observedOutputRoots }) => observedOutputRoots,
        ),
      };
    }),
    receipts: {
      verificationReceiptRoot: input.shadowReceipt.verificationReceiptRoot,
      currentPlanRoot: input.shadowReceipt.currentPlanRoot,
      currentReceiptRoot: input.shadowReceipt.currentReceiptRoot,
      graphReceiptRoot: input.receipt.receiptRoot,
      shadowReceiptRoot: input.shadowReceipt.receiptRoot,
    },
    parity: input.shadowReceipt.parity,
    failure: input.failure
      ? {
          root: input.failure.failureRoot,
          nodeId: input.failure.nodeId,
          classification: input.failure.classification,
          owner: input.failure.owner,
        }
      : null,
    recovery: {
      root: input.recovery?.recoveryRoot || null,
      eligible: decision.state === 'resume-eligible',
      strategy: input.recovery?.strategy || null,
      resumeFromNode: input.recovery?.resumeFromNode || null,
      externallyBlocked: decision.externallyBlocked,
      requiredEvidenceRoots: input.recovery?.requiredEvidenceRoots || [],
    },
    events: input.events.map(
      ({
        eventRoot,
        nodeId,
        sequence,
        state,
        observedOutputRoots,
        failureRoot,
      }) => ({
        root: eventRoot,
        nodeId,
        sequence,
        state,
        observedOutputRoots,
        failureRoot,
      }),
    ),
    outputRoots: input.receipt.outputRoots,
    retainedEvidenceRoots: input.receipt.retainedEvidenceRoots,
    diagnostics: exactDiagnostics,
    nextAction: decision.nextAction,
  };
  return rooted(feedback, 'feedbackRoot');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readOptionalJson(file) {
  return file && fs.existsSync(file) ? readJson(file) : null;
}

function artifactPath(shadowReceiptPath, value) {
  if (!value) return '';
  return path.isAbsolute(value)
    ? value
    : path.resolve(path.dirname(shadowReceiptPath), value);
}

function readEvents(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const options = {
    graph: '',
    plan: '',
    shadowReceipt: '',
    projectRoot: ROOT,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--graph') options.graph = argv[++index];
    else if (arg === '--plan') options.plan = argv[++index];
    else if (arg === '--shadow-receipt') options.shadowReceipt = argv[++index];
    else if (arg === '--project-root') options.projectRoot = argv[++index];
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ['graph', 'plan', 'shadowReceipt']) {
    if (!options[field]) {
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)} is required`,
      );
    }
  }
  return options;
}

function loadFeedbackInput(options) {
  const shadowReceiptPath = path.resolve(options.shadowReceipt);
  const shadowReceipt = readJson(shadowReceiptPath);
  const artifacts = shadowReceipt.artifacts || {};
  return {
    graph: readJson(path.resolve(options.graph)),
    plan: readJson(path.resolve(options.plan)),
    events: readEvents(artifactPath(shadowReceiptPath, artifacts.events)),
    receipt: readJson(artifactPath(shadowReceiptPath, artifacts.graphReceipt)),
    failure: readOptionalJson(
      artifactPath(shadowReceiptPath, artifacts.failure),
    ),
    recovery: readOptionalJson(
      artifactPath(shadowReceiptPath, artifacts.recovery),
    ),
    shadowReceipt,
    currentPlan: readOptionalJson(
      artifactPath(shadowReceiptPath, artifacts.currentPlan),
    ),
    currentReceipt: readOptionalJson(
      artifactPath(shadowReceiptPath, artifacts.currentReceipt),
    ),
  };
}

export function renderProductionGraphFeedback(feedback) {
  const lines = [
    `Production Graph feedback: ${feedback.state} (exit ${feedback.exitCode})`,
    `Source: ${feedback.source.repository} @ ${feedback.source.revision} tree ${feedback.source.tree}`,
    `Graph: ${feedback.graph.id} ${feedback.graph.graphRoot}`,
    `Plan: ${feedback.graph.planRoot}`,
    `Xinfa selection: ${feedback.graph.xinfaSelectionRoot}`,
    'Nodes:',
    ...feedback.nodes.map(
      (node) =>
        `- ${node.id}: ${node.state} via ${node.executor.entrypoint} ${node.executor.task}`,
    ),
    `Events: ${feedback.events.length}; outputs: ${feedback.outputRoots.length}`,
    `Receipts: current=${feedback.receipts.currentReceiptRoot || 'none'} graph=${feedback.receipts.graphReceiptRoot} shadow=${feedback.receipts.shadowReceiptRoot}`,
    `Parity: ${feedback.parity.status} (${feedback.parity.classification})`,
    feedback.failure
      ? `Failure: ${feedback.failure.nodeId} (${feedback.failure.classification}); owner=${feedback.failure.owner}`
      : 'Failure: none',
    `Recovery: eligible=${feedback.recovery.eligible}; strategy=${feedback.recovery.strategy || 'none'}; externallyBlocked=${feedback.recovery.externallyBlocked}`,
    `Retained evidence: ${feedback.retainedEvidenceRoots.join(', ') || 'none'}`,
  ];
  if (feedback.diagnostics.length) {
    lines.push('Diagnostics:');
    lines.push(
      ...feedback.diagnostics.map(
        ({ code, path: pathValue, message }) =>
          `- ${code} ${pathValue}: ${message}`,
      ),
    );
  }
  lines.push(`Next action: ${feedback.nextAction}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = loadFeedbackInput(options);
  const feedback = await createProductionGraphFeedback(input, {
    observed: observedProjectContext(path.resolve(options.projectRoot)),
    verifyCurrent: true,
    root: path.resolve(options.projectRoot),
  });
  console.log(
    options.json
      ? JSON.stringify(feedback, null, 2)
      : renderProductionGraphFeedback(feedback),
  );
  process.exitCode = feedback.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[production-graph-feedback] ${error.message}`);
    process.exitCode = 3;
  });
}
