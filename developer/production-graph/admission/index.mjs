// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
  contractRoot,
  fileRoot,
  rooted,
  schemaValidators,
  semanticRoot,
} from '../contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export const REJECTION_CODES = Object.freeze({
  invalidRequest: 'invalid-request',
  missingWork: 'missing-work',
  missingAuthorization: 'missing-authorization',
  staleWork: 'stale-work',
  staleAuthorization: 'stale-authorization',
  unauthorized: 'unauthorized',
  graphDrift: 'graph-drift',
  planDrift: 'plan-drift',
  sourceDrift: 'source-drift',
  authorityDrift: 'authority-drift',
  xinfaDrift: 'xinfa-drift',
  executorPolicyMismatch: 'executor-policy-mismatch',
  workRefMismatch: 'work-ref-mismatch',
  workRootMismatch: 'work-root-mismatch',
  authorizationRootMismatch: 'authorization-root-mismatch',
  actorMismatch: 'actor-mismatch',
  attemptMismatch: 'attempt-mismatch',
  nodeSetMismatch: 'node-set-mismatch',
  expiredWorkLease: 'expired-work-lease',
  expiredAuthorization: 'expired-authorization',
  authorizationNotYetValid: 'authorization-not-yet-valid',
  replayedAuthorization: 'replayed-authorization',
  missingExecutionClaim: 'missing-execution-claim',
});

const AUTHORIZATION_AUTHORITIES = new Set([
  'kungfu.work-control',
  'kungfu.warrant',
  'external-approval-authority',
]);

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validRoot(document, field) {
  return Boolean(
    document &&
      typeof document === 'object' &&
      document[field] &&
      rooted(document, field)[field] === document[field],
  );
}

function timestamp(value) {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value);
}

function add(codes, condition, code) {
  if (condition) codes.add(code);
}

function schemaCodes(validate, request) {
  if (validate(request)) return [];
  return (validate.errors || []).map((error) => {
    const missing = error.params?.missingProperty;
    if (error.keyword === 'required' && missing === 'work') {
      return REJECTION_CODES.missingWork;
    }
    if (error.keyword === 'required' && missing === 'authorization') {
      return REJECTION_CODES.missingAuthorization;
    }
    return REJECTION_CODES.invalidRequest;
  });
}

function expectedFromRequest(request) {
  return {
    contractRoot: request?.graph?.contractRoot,
    graphRoot: request?.graph?.graphRoot,
    planRoot: request?.plan?.planRoot,
    sourceRevision: request?.graph?.source?.revision,
    sourceTree: request?.graph?.source?.tree,
    authorityReferences: request?.graph?.authorityReferences,
    xinfaSelectionRoot: request?.graph?.semanticImpact?.selectionRoot,
    executorPolicyRoot: request?.executorPolicyRoot,
  };
}

export async function verifyExecutionAdmissionRequest(
  request,
  {
    root = ROOT,
    expected = expectedFromRequest(request),
    validators = null,
  } = {},
) {
  const checks = validators || (await schemaValidators(root));
  const codes = new Set(schemaCodes(checks.executionAdmissionRequest, request));
  const graph = request?.graph;
  const plan = request?.plan;
  const work = request?.work;
  const authorization = request?.authorization;

  add(codes, !work, REJECTION_CODES.missingWork);
  add(codes, !authorization, REJECTION_CODES.missingAuthorization);
  add(
    codes,
    !validRoot(request, 'requestRoot'),
    REJECTION_CODES.invalidRequest,
  );
  add(codes, !validRoot(graph, 'graphRoot'), REJECTION_CODES.graphDrift);
  add(codes, !validRoot(plan, 'planRoot'), REJECTION_CODES.planDrift);

  if (graph && plan) {
    add(
      codes,
      plan.contractRoot !== graph.contractRoot,
      REJECTION_CODES.graphDrift,
    );
    add(codes, plan.graphRoot !== graph.graphRoot, REJECTION_CODES.graphDrift);
    add(
      codes,
      plan.sourceRevision !== graph.source?.revision,
      REJECTION_CODES.sourceDrift,
    );
    add(
      codes,
      !same(plan.authorityReferences, graph.authorityReferences),
      REJECTION_CODES.authorityDrift,
    );
    add(
      codes,
      plan.xinfaSelectionRoot !== graph.semanticImpact?.selectionRoot,
      REJECTION_CODES.xinfaDrift,
    );
  }

  if (expected) {
    add(
      codes,
      graph?.contractRoot !== expected.contractRoot,
      REJECTION_CODES.graphDrift,
    );
    add(
      codes,
      graph?.graphRoot !== expected.graphRoot,
      REJECTION_CODES.graphDrift,
    );
    add(codes, plan?.planRoot !== expected.planRoot, REJECTION_CODES.planDrift);
    add(
      codes,
      graph?.source?.revision !== expected.sourceRevision ||
        graph?.source?.tree !== expected.sourceTree,
      REJECTION_CODES.sourceDrift,
    );
    add(
      codes,
      !same(graph?.authorityReferences, expected.authorityReferences),
      REJECTION_CODES.authorityDrift,
    );
    add(
      codes,
      graph?.semanticImpact?.selectionRoot !== expected.xinfaSelectionRoot,
      REJECTION_CODES.xinfaDrift,
    );
    add(
      codes,
      request?.executorPolicyRoot !== expected.executorPolicyRoot,
      REJECTION_CODES.executorPolicyMismatch,
    );
  }

  if (work) {
    add(
      codes,
      work.authority !== 'kungfu.work-control' ||
        work.status !== 'verified' ||
        work.phase !== 'executing',
      REJECTION_CODES.staleWork,
    );
    add(
      codes,
      !validRoot(work, 'verificationRoot'),
      REJECTION_CODES.workRootMismatch,
    );
    add(
      codes,
      semanticRoot(work.workRef ?? null) !== work.workRefRoot ||
        work.workRef?.entityRoot !== work.assignmentRequestRoot ||
        work.workRef?.systemTimeCut !== work.queryProofRoot,
      REJECTION_CODES.workRefMismatch,
    );
    add(codes, work.actor !== request?.actor, REJECTION_CODES.actorMismatch);
    add(
      codes,
      work.attemptId !== request?.attemptId,
      REJECTION_CODES.attemptMismatch,
    );
  }

  if (authorization) {
    add(
      codes,
      authorization.status !== 'verified',
      REJECTION_CODES.staleAuthorization,
    );
    add(
      codes,
      authorization.decision !== 'allowed' ||
        typeof authorization.authority !== 'string' ||
        !AUTHORIZATION_AUTHORITIES.has(authorization.authority),
      REJECTION_CODES.unauthorized,
    );
    add(
      codes,
      !validRoot(authorization, 'verificationRoot'),
      REJECTION_CODES.authorizationRootMismatch,
    );
    add(
      codes,
      authorization.actor !== request?.actor,
      REJECTION_CODES.actorMismatch,
    );
    add(
      codes,
      authorization.attemptId !== request?.attemptId,
      REJECTION_CODES.attemptMismatch,
    );
    add(
      codes,
      authorization.executorPolicyRoot !== request?.executorPolicyRoot,
      REJECTION_CODES.executorPolicyMismatch,
    );
    add(
      codes,
      !same(authorization.intendedNodeIds, request?.intendedNodeIds) ||
        !same(request?.intendedNodeIds, plan?.orderedNodeIds),
      REJECTION_CODES.nodeSetMismatch,
    );
    add(
      codes,
      authorization.replayState !== 'fresh',
      REJECTION_CODES.replayedAuthorization,
    );
    add(
      codes,
      !authorization.evidence?.some(
        (evidence) =>
          evidence?.kind === 'execution-claim' &&
          evidence?.root === work?.executionClaimRoot,
      ),
      REJECTION_CODES.missingExecutionClaim,
    );
  }

  const observedAt = timestamp(request?.observedAt);
  add(codes, !Number.isFinite(observedAt), REJECTION_CODES.invalidRequest);
  if (Number.isFinite(observedAt)) {
    add(
      codes,
      timestamp(work?.leaseExpiresAt) <= observedAt,
      REJECTION_CODES.expiredWorkLease,
    );
    add(
      codes,
      timestamp(authorization?.expiresAt) <= observedAt,
      REJECTION_CODES.expiredAuthorization,
    );
    add(
      codes,
      timestamp(authorization?.issuedAt) > observedAt,
      REJECTION_CODES.authorizationNotYetValid,
    );
  }

  return { valid: codes.size === 0, codes: [...codes].sort() };
}

function rejectionFor(request, inputRoot, codes) {
  return rooted(
    {
      schema: 'shifu.production-graph-execution-admission-rejection/v0',
      inputRoot,
      requestRoot: validRoot(request, 'requestRoot')
        ? request.requestRoot
        : null,
      codes,
      nodesStarted: false,
      authorityMutations: [],
      nextAction:
        'refresh native Work and external authorization evidence, then submit a new exact execution-admission request',
    },
    'rejectionRoot',
  );
}

export async function createExecutionAdmissionDecision(request, options = {}) {
  const inputRoot = semanticRoot(request ?? null);
  const verification = await verifyExecutionAdmissionRequest(request, options);
  const rejection = verification.valid
    ? null
    : rejectionFor(request, inputRoot, verification.codes);
  const admitted = verification.valid;
  const graph = request?.graph;
  const work = request?.work;
  const authorization = request?.authorization;
  const decision = rooted(
    {
      schema: 'shifu.production-graph-execution-admission-decision/v0',
      status: admitted ? 'admitted' : 'rejected',
      inputRoot,
      requestRoot: validRoot(request, 'requestRoot')
        ? request.requestRoot
        : null,
      contractRoot: admitted ? graph.contractRoot : null,
      graphRoot: admitted ? graph.graphRoot : null,
      planRoot: admitted ? request.plan.planRoot : null,
      sourceRevision: admitted ? graph.source.revision : null,
      sourceTree: admitted ? graph.source.tree : null,
      authorityReferences: admitted ? graph.authorityReferences : null,
      xinfaSelectionRoot: admitted ? graph.semanticImpact.selectionRoot : null,
      executorPolicyRoot: admitted ? request.executorPolicyRoot : null,
      workRefRoot: admitted ? work.workRefRoot : null,
      workVerificationRoot: admitted ? work.verificationRoot : null,
      authorizationEvidenceRoots: admitted
        ? authorization.evidence.map(({ root }) => root).sort()
        : [],
      authorizationVerificationRoot: admitted
        ? authorization.verificationRoot
        : null,
      actor: admitted ? request.actor : null,
      attemptId: admitted ? request.attemptId : null,
      intendedNodeIds: admitted ? request.intendedNodeIds : [],
      expiresAt: admitted
        ? [work.leaseExpiresAt, authorization.expiresAt].sort(
            (left, right) => timestamp(left) - timestamp(right),
          )[0]
        : null,
      rejectionRoot: rejection?.rejectionRoot || null,
      nodesStarted: false,
      authorityMutations: [],
      nextAction: admitted
        ? 'start only the admitted node set before expiresAt'
        : rejection.nextAction,
    },
    'decisionRoot',
  );
  const checks =
    options.validators || (await schemaValidators(options.root || ROOT));
  const validate = checks.executionAdmissionDecision;
  if (!validate(decision)) {
    throw new Error(
      `execution admission decision schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
  }
  if (rejection && !checks.executionAdmissionRejection(rejection)) {
    throw new Error(
      `execution admission rejection schema invalid: ${JSON.stringify(checks.executionAdmissionRejection.errors || [])}`,
    );
  }
  return { decision, rejection, verification };
}

function parseArgs(argv) {
  const options = { request: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request') options.request = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.request) throw new Error('--request is required');
  return options;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const request = JSON.parse(fs.readFileSync(options.request, 'utf8'));
  const expected = {
    ...expectedFromRequest(request),
    contractRoot: contractRoot(ROOT),
    sourceRevision: git(ROOT, 'rev-parse', 'HEAD'),
    sourceTree: git(ROOT, 'rev-parse', 'HEAD^{tree}'),
    authorityReferences: {
      layers: fileRoot(
        path.join(ROOT, 'framework/core/architecture/layers.json'),
      ),
      buildCapabilities: fileRoot(
        path.join(ROOT, 'framework/core/architecture/build-capabilities.json'),
      ),
    },
  };
  const result = await createExecutionAdmissionDecision(request, {
    root: ROOT,
    expected,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) fs.writeFileSync(options.output, output);
  else process.stdout.write(output);
  if (result.decision.status !== 'admitted') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[production-graph-admission] ${error.message}`);
    process.exitCode = 1;
  });
}
