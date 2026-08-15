#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_MAX_AGE_SECONDS,
  PRODUCER_EVENTS,
  WORKFLOW_PATH,
  lookupReusableArtifact,
  requireSha,
} from '../framework/release/affected-native-artifact-lookup.mjs';
import { parseFamilyQueueLeaseMarker } from './project-cut-merge-queue-admission.mjs';

export {
  DEFAULT_MAX_AGE_SECONDS,
  WORKFLOW_PATH,
  lookupReusableArtifact,
  selectReusableArtifact,
} from '../framework/release/affected-native-artifact-lookup.mjs';

const LEGACY_IDENTITY_SCHEMA = 'kungfu.affected-native-proof-identity/v3';
const LEGACY_PROOF_SCHEMA = 'kungfu.affected-native-proof/v3';
const LEGACY_DESCRIPTOR_SCHEMA = 'kungfu.affected-native-proof-descriptor/v1';
export const IDENTITY_SCHEMA = 'kungfu.affected-native-proof-identity/v6';
export const QUALIFICATION_IDENTITY_SCHEMA =
  'kungfu.affected-native-qualification-identity/v3';
export const PROOF_SCHEMA = 'kungfu.affected-native-proof/v6';
export const DESCRIPTOR_SCHEMA = 'kungfu.affected-native-proof-descriptor/v4';
export const DELIVERY_BINDING_SCHEMA =
  'kungfu.affected-native-delivery-binding/v1';
export const DELIVERY_ATTEMPT_SCHEMA =
  'kungfu.affected-native-delivery-attempt/v1';
export const CACHE_PROMOTION_AUTHORITY_SCHEMA =
  'kungfu.affected-native-cache-promotion-authority/v1';
export const DEV_DELIVERY_CONSUMER_RECEIPT_SCHEMA =
  'kungfu.dev-delivery-warrant-consumer-receipt/v1';
export const DEV_DELIVERY_COMMAND_RESULT_SCHEMA =
  'kungfu.buildchain.dev-delivery-command-result/v1';
export const DEV_DELIVERY_QUEUE_OBSERVATION_SCHEMA =
  'kungfu.buildchain.dev-delivery-queue-observation/v1';
export const GITHUB_ENQUEUE_RECEIPT_SCHEMA =
  'kungfu-buildchain-dev-delivery-github-enqueue/v1';
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(ordered(value));
}

export function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex')}`;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireDevBase(value) {
  const normalized = requireText(value, 'protected base').replace(
    /^refs\/heads\//u,
    '',
  );
  if (!/^dev\/v\d+\/v\d+\.\d+$/u.test(normalized)) {
    throw new Error('protected base must be a dev channel');
  }
  return normalized;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function verifyNativeProof(descriptor, proof, plan, sourceHeadSha) {
  validatePlan(plan);
  if (descriptor?.schema !== DESCRIPTOR_SCHEMA) {
    throw new Error('current affected-native descriptor is required');
  }
  if (proof?.schema !== PROOF_SCHEMA) {
    throw new Error('current affected-native proof is required');
  }
  const { proofRoot, ...proofBody } = proof;
  if (proofRoot !== digest(proofBody)) {
    throw new Error('affected-native proof root drift');
  }
  if (
    digest(proof.qualificationIdentity) !== `sha256:${descriptor.proofId}` ||
    JSON.stringify(proof.qualificationIdentity) !==
      JSON.stringify(descriptor.qualificationIdentity)
  ) {
    throw new Error('affected-native qualification identity drift');
  }
  if (
    proof.producer?.event !== 'pull_request' ||
    proof.producer?.triggerHeadSha !== sourceHeadSha ||
    plan.head !== proof.producer?.checkoutSha ||
    proof.verdict?.status !== 'passed'
  ) {
    throw new Error(
      'source proof is not bound to the exact successful PR head',
    );
  }
  return proof;
}

function affectedClosure(plan) {
  const affectedPrefixes = sortedUnique(
    (plan.reasons || [])
      .map((reason) => String(reason?.path || '').replace(/^\.\//u, ''))
      .filter(Boolean)
      .map((entry) => entry.split('/')[0]),
  );
  if (affectedPrefixes.length === 0) {
    throw new Error('affected-native plan has no attributable path prefix');
  }
  return {
    shards: [
      {
        id: 'affected-native',
        pathPrefixes: affectedPrefixes,
        qualificationContext: 'affected-native / linux',
      },
    ],
    unrelatedPathPrefixes: ['docs'].filter(
      (entry) => !affectedPrefixes.includes(entry),
    ),
  };
}

export function createSourceQualificationInput(input = {}) {
  const repository = requireRepository(input.repository, 'repository');
  const protectedBase = requireDevBase(input.protectedBase);
  const pullRequestNumber = requirePositiveInteger(
    input.pullRequestNumber,
    'pull request number',
  );
  const sourceHeadSha = requireSha(input.sourceHeadSha, 'source head SHA');
  const proof = verifyNativeProof(
    input.descriptor,
    input.proof,
    input.plan,
    sourceHeadSha,
  );
  const identity = input.descriptor.qualificationIdentity;
  return {
    repository,
    protectedBase,
    pullRequestNumber,
    sourceHeadSha,
    semanticSourceRoot: digest(identity),
    sourceIntentRoot: digest({
      planProjectionDigest: identity.planProjectionDigest,
      sourceTree: identity.sourceTree,
      closureRoot: identity.closureRoot,
    }),
    planRoot: requireRoot(input.plan.planDigest, 'qualification plan root'),
    affectedClosure: affectedClosure(input.plan),
    dependencyGraphRoot: requireRoot(
      identity.dependencyRoot,
      'dependency graph root',
    ),
    toolchainRoot: digest(identity.toolchain),
    requiredContexts: [
      {
        name: 'affected-native / linux',
        conclusion: 'success',
        headSha: sourceHeadSha,
        evidenceRoot: proof.proofRoot,
      },
    ],
    evidenceRoots: sortedUnique([
      proof.proofRoot,
      ...proof.partitions.map((entry) =>
        requireRoot(entry.receiptDigest, 'partition receipt digest'),
      ),
    ]),
  };
}

function activeWarrantCandidate(result, pullRequestNumber, sourceHeadSha) {
  if (result?.schema !== DEV_DELIVERY_COMMAND_RESULT_SCHEMA) {
    throw new Error('Buildchain Warrant command result schema mismatch');
  }
  const observation = result.observation;
  if (observation?.schema !== DEV_DELIVERY_QUEUE_OBSERVATION_SCHEMA) {
    throw new Error('Buildchain Warrant observation schema mismatch');
  }
  requireRoot(observation.stateRoot, 'queue state root');
  const warrant = observation.activeWarrant;
  if (!warrant) throw new Error('active Delivery Warrant is required');
  for (const field of ['candidateId', 'fencingToken'])
    requireRoot(warrant[field], `Warrant ${field}`);
  requirePositiveInteger(warrant.generation, 'Warrant generation');
  const candidate = observation.activeCandidate;
  if (!candidate) throw new Error('active Warrant candidate is missing');
  if (
    candidate.pullRequestNumber !== pullRequestNumber ||
    candidate.sourceHead !== sourceHeadSha ||
    candidate.candidateId !== warrant.candidateId ||
    warrant.pullRequestNumber !== pullRequestNumber ||
    warrant.sourceHead !== sourceHeadSha
  ) {
    throw new Error('active Warrant exact source readback mismatch');
  }
  requireRoot(candidate.sourceProofRoot, 'candidate Source Proof root');
  if (candidate.sourceProofRoot !== warrant.sourceProofRoot) {
    throw new Error('active Warrant Source Proof readback mismatch');
  }
  return { observation, warrant, candidate };
}

export function verifyQueueAdmissionLease(input = {}) {
  const pullRequestNumber = requirePositiveInteger(
    input.pullRequestNumber,
    'pull request number',
  );
  const sourceHeadSha = requireSha(input.sourceHeadSha, 'source head SHA');
  const { observation, warrant, candidate } = activeWarrantCandidate(
    input.view,
    pullRequestNumber,
    sourceHeadSha,
  );
  if (warrant.phase !== 'qualified' || candidate.status !== 'qualified') {
    throw new Error(
      `active Warrant candidate is not delivery-ready: ${candidate.status}`,
    );
  }
  for (const field of ['nativeProofRoot', 'nativeProofReuseRoot'])
    requireRoot(warrant[field], `Warrant ${field}`);
  const observedAt = new Date(input.now || observation.observedAt).getTime();
  if (
    !Number.isFinite(observedAt) ||
    observedAt >= new Date(warrant.expiresAt).getTime()
  ) {
    throw new Error('active Delivery Warrant is expired');
  }
  const body = {
    schema: DEV_DELIVERY_CONSUMER_RECEIPT_SCHEMA,
    operation: 'queue-lease-verify',
    repository: requireRepository(observation.repository, 'repository'),
    protectedBase: requireDevBase(observation.protectedBase),
    queueStateRoot: observation.stateRoot,
    pullRequestNumber,
    sourceHeadSha,
    candidateId: warrant.candidateId,
    sourceProofRoot: candidate.sourceProofRoot,
    nativeProofRoot: warrant.nativeProofRoot,
    nativeProofReuseRoot: warrant.nativeProofReuseRoot,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    candidateState: candidate.status,
    observedAt: new Date(observedAt).toISOString(),
  };
  return { ...body, receiptRoot: digest(body) };
}

function createProviderReceipt(observation, candidate, warrant, queueEntry) {
  const body = {
    schema: GITHUB_ENQUEUE_RECEIPT_SCHEMA,
    repository: requireRepository(observation.repository, 'repository'),
    protectedBase: requireDevBase(observation.protectedBase),
    candidateId: warrant.candidateId,
    sourceHeadSha: candidate.sourceHead,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    expiresAt: requireText(warrant.expiresAt, 'Warrant expiry'),
    queueEntryId: requireText(queueEntry?.id, 'merge queue entry id'),
    queueEntryState: requireText(queueEntry?.state, 'merge queue entry state'),
    recoveredAfterControllerRestart:
      queueEntry?.recoveredAfterControllerRestart === true,
    queueStateRoot: requireRoot(observation.stateRoot, 'queue state root'),
  };
  return { ...body, receiptRoot: digest(body) };
}

export function createIntegrationDeliveryInput(input = {}) {
  const attempt = validateDeliveryAttempt(input.deliveryAttempt);
  const pullRequestNumber = requirePositiveInteger(
    input.pullRequestNumber,
    'pull request number',
  );
  const { observation, warrant, candidate } = activeWarrantCandidate(
    input.view,
    pullRequestNumber,
    attempt.source.pullRequestHead,
  );
  const integrationHead = requireSha(
    attempt.source.mergeGroupHead,
    'merge-group integration head',
  );
  const queueEntry = input.queueEntry || {};
  if (
    Number(queueEntry.pullRequestNumber) !== pullRequestNumber ||
    queueEntry.pullRequestHeadSha !== candidate.sourceHead
  ) {
    throw new Error('GitHub merge queue exact-head readback mismatch');
  }
  const providerReceipt = createProviderReceipt(
    observation,
    candidate,
    warrant,
    queueEntry,
  );
  return {
    providerReceipt,
    proofInput: {
      repository: observation.repository,
      protectedBase: observation.protectedBase,
      sourceProofRoot: candidate.sourceProofRoot,
      currentBase: requireSha(attempt.source.devHead, 'protected base SHA'),
      replayTree: requireSha(attempt.source.replayedTree, 'replay tree SHA'),
      mergeGroupHead: integrationHead,
      mergeGroupTree: requireSha(
        attempt.source.replayedTree,
        'merge-group tree SHA',
      ),
      requiredContextRoots: sortedUnique([
        requireRoot(attempt.attemptRoot, 'delivery attempt root'),
        requireRoot(
          input.queueLeaseReceipt?.receiptRoot,
          'queue lease receipt root',
        ),
        providerReceipt.receiptRoot,
      ]),
      verifiedAt: requireText(
        input.verifiedAt,
        'integration verification time',
      ),
    },
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireRunId(value, label) {
  const runId = Number(value);
  if (!Number.isInteger(runId) || runId < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return runId;
}

function requireRepository(value, label) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value || '')) {
    throw new Error(`${label} must be an exact repository`);
  }
  return value;
}

function requireRoot(value, label) {
  if (!SHA256_ROOT.test(value || '')) {
    throw new Error(`${label} must be an exact sha256 root`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value || '')) {
    throw new Error(`${label} must be an exact bounded identifier`);
  }
  return value;
}

function requireContext(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,199}$/u.test(value || '')) {
    throw new Error(`${label} must be an exact status context`);
  }
  return value;
}

function requireQueueAttempt(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value || '')) {
    throw new Error('family queue attempt must be exact');
  }
  return value;
}

function normalizedContexts(values) {
  const contexts = [...new Set((values || []).map(String))].sort();
  if (
    contexts.some(
      (context) => !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,199}$/u.test(context),
    )
  ) {
    throw new Error('required check context is invalid');
  }
  return contexts;
}

export function requiredContextsFromRules(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('expected effective branch rules array');
  }
  return normalizedContexts(
    rules
      .filter(({ type }) => type === 'required_status_checks')
      .flatMap(({ parameters }) => parameters?.required_status_checks || [])
      .map(({ context }) => context)
      .filter(Boolean),
  );
}

function latestStatus(combinedStatus, context) {
  return (combinedStatus?.statuses || []).find(
    (status) => status?.context === context,
  );
}

export function createDeliveryBinding({
  event,
  pullRequest,
  pullRequestHead,
  devHead,
  candidateHead,
  candidateTree,
  pullRequestBody = '',
  combinedStatus = {},
  requiredContexts = [],
  queueAdmissionContext,
}) {
  if (!PRODUCER_EVENTS.has(event)) {
    throw new Error('delivery binding event is unsupported');
  }
  const source = {
    pullRequest: requireRunId(pullRequest, 'delivery pull request'),
    pullRequestHead: requireSha(pullRequestHead, 'delivery pull request head'),
  };
  const contexts = normalizedContexts(requiredContexts);
  const queueContext = requireContext(
    queueAdmissionContext,
    'queue admission context',
  );
  if (event === 'pull_request') {
    const body = {
      schema: DELIVERY_BINDING_SCHEMA,
      state: 'unbound',
      source,
      requiredChecks: {
        contexts,
        root: digest({ contexts }),
      },
      queueAdmission: {
        context: queueContext,
        state: 'not-issued',
      },
      reason: 'family-lease-issued-only-after-pr-qualification',
    };
    return { ...body, bindingRoot: digest(body) };
  }
  const lease = parseFamilyQueueLeaseMarker(pullRequestBody);
  const exactDevHead = requireSha(devHead, 'delivery dev head');
  const exactCandidateHead = requireSha(
    candidateHead,
    'delivery candidate head',
  );
  const exactCandidateTree = requireSha(
    candidateTree,
    'delivery candidate tree',
  );
  const queueStatus = latestStatus(combinedStatus, queueContext);
  if (queueStatus?.state !== 'success') {
    throw new Error('queue admission lease is not successful');
  }
  if (lease === null) {
    const body = {
      schema: DELIVERY_BINDING_SCHEMA,
      state: 'bound',
      source: {
        ...source,
        devHead: exactDevHead,
        replayedCandidate: exactCandidateHead,
        replayedTree: exactCandidateTree,
      },
      family: null,
      requiredChecks: {
        contexts,
        root: digest({ contexts }),
      },
      queueAdmission: {
        context: queueContext,
        state: queueStatus.state,
        familyLeaseState: 'not-applicable',
        root: digest({
          context: queueContext,
          state: queueStatus.state,
          familyLeaseState: 'not-applicable',
        }),
      },
      reason: 'exact-queue-admission-without-family-lease',
    };
    return { ...body, bindingRoot: digest(body) };
  }
  if (
    lease.pullRequestHead !== source.pullRequestHead ||
    lease.devHead !== exactDevHead ||
    lease.replayedTree !== exactCandidateTree
  ) {
    throw new Error('family delivery source or latest-dev replay drift');
  }
  const familyStatus = latestStatus(combinedStatus, lease.statusContext);
  if (familyStatus?.state !== 'pending') {
    throw new Error('family delivery lease is not active');
  }
  const admissionProofRoots = [
    ...new Set((lease.admissionProofRoots || []).map(String)),
  ].sort();
  for (const root of admissionProofRoots) {
    requireRoot(root, 'family admission proof root');
  }
  const body = {
    schema: DELIVERY_BINDING_SCHEMA,
    state: 'bound',
    source: {
      ...source,
      devHead: exactDevHead,
      // GitHub preserves the admitted base and tree but rewrites commit
      // metadata when it creates the merge-group candidate. Bind delivery to
      // that provider-issued head while the family lease continues to seal
      // the deterministic Project Cut replay through its lease root.
      replayedCandidate: exactCandidateHead,
      replayedTree: exactCandidateTree,
    },
    family: {
      initiativeId: requireIdentifier(
        lease.initiativeId,
        'family initiative id',
      ),
      assignmentId: requireIdentifier(
        lease.assignmentId,
        'family assignment id',
      ),
      deliveryClass: requireIdentifier(
        lease.deliveryClass,
        'family delivery class',
      ),
      queueAttempt: requireQueueAttempt(lease.queueAttempt),
      leaseRoot: requireRoot(lease.leaseRoot, 'family lease root'),
      admissionProofRoot: requireRoot(
        lease.admissionProofRoot,
        'family replay admission proof root',
      ),
      admissionProofRoots,
      statusContext: requireContext(
        lease.statusContext,
        'family status context',
      ),
    },
    requiredChecks: {
      contexts,
      root: digest({ contexts }),
    },
    queueAdmission: {
      context: queueContext,
      state: queueStatus.state,
      familyLeaseState: familyStatus.state,
      root: digest({
        context: queueContext,
        state: queueStatus.state,
        familyLeaseRoot: lease.leaseRoot,
        familyLeaseState: familyStatus.state,
      }),
    },
  };
  return { ...body, bindingRoot: digest(body) };
}

export function validateDeliveryBinding(binding) {
  const { bindingRoot, ...body } = binding || {};
  if (
    body.schema !== DELIVERY_BINDING_SCHEMA ||
    bindingRoot !== digest(body) ||
    !['bound', 'unbound'].includes(body.state)
  ) {
    throw new Error('affected-native delivery binding root drift');
  }
  requireRunId(body.source?.pullRequest, 'delivery pull request');
  requireSha(body.source?.pullRequestHead, 'delivery pull request head');
  const contexts = normalizedContexts(body.requiredChecks?.contexts);
  if (body.requiredChecks?.root !== digest({ contexts })) {
    throw new Error('affected-native required-check binding drift');
  }
  requireContext(body.queueAdmission?.context, 'queue admission context');
  if (body.state === 'bound') {
    requireSha(body.source?.devHead, 'delivery dev head');
    requireSha(body.source?.replayedCandidate, 'delivery replayed candidate');
    requireSha(body.source?.replayedTree, 'delivery replayed tree');
    if (body.queueAdmission?.state !== 'success') {
      throw new Error('affected-native delivery admission state drift');
    }
    if (body.family === null) {
      if (
        body.queueAdmission?.familyLeaseState !== 'not-applicable' ||
        body.reason !== 'exact-queue-admission-without-family-lease'
      ) {
        throw new Error('affected-native non-family delivery state drift');
      }
    } else {
      requireIdentifier(body.family?.initiativeId, 'family initiative id');
      requireIdentifier(body.family?.assignmentId, 'family assignment id');
      requireIdentifier(body.family?.deliveryClass, 'family delivery class');
      requireQueueAttempt(body.family?.queueAttempt);
      requireRoot(body.family?.leaseRoot, 'family lease root');
      requireRoot(
        body.family?.admissionProofRoot,
        'family replay admission proof root',
      );
      for (const root of body.family?.admissionProofRoots || []) {
        requireRoot(root, 'family admission proof root');
      }
      requireContext(body.family?.statusContext, 'family status context');
      if (body.queueAdmission?.familyLeaseState !== 'pending') {
        throw new Error('affected-native delivery admission state drift');
      }
    }
    requireRoot(body.queueAdmission?.root, 'queue admission root');
  } else if (
    body.queueAdmission?.state !== 'not-issued' ||
    body.reason !== 'family-lease-issued-only-after-pr-qualification'
  ) {
    throw new Error('affected-native unbound delivery state drift');
  }
  return binding;
}

function commandFact(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  const fact = (result.stdout || result.stderr || '').split('\n')[0].trim();
  if (result.error || result.status !== 0 || !fact) {
    throw new Error(`affected-native toolchain probe failed for ${command}`);
  }
  return fact;
}

export function observeNativeToolchain(env = process.env, commands = {}) {
  return {
    compiler: commandFact(commands.compiler || env.CXX || 'c++'),
    cmake: commandFact(commands.cmake || 'cmake'),
    ninja: commandFact(commands.ninja || 'ninja'),
    runner: {
      environment: env.RUNNER_ENVIRONMENT || 'local',
      os: env.RUNNER_OS || process.platform,
      arch: env.RUNNER_ARCH || process.arch,
      imageOS: env.ImageOS || null,
      imageVersion: env.ImageVersion || null,
    },
  };
}

function validateNativeToolchain(toolchain, requireHosted = false) {
  for (const tool of ['compiler', 'cmake', 'ninja']) {
    if (typeof toolchain?.[tool] !== 'string' || !toolchain[tool]) {
      throw new Error(`affected-native toolchain is missing ${tool} fact`);
    }
  }
  const runner = toolchain?.runner;
  for (const fact of ['environment', 'os', 'arch']) {
    if (typeof runner?.[fact] !== 'string' || !runner[fact]) {
      throw new Error(`affected-native toolchain is missing runner ${fact}`);
    }
  }
  if (
    requireHosted &&
    (runner.environment !== 'github-hosted' ||
      typeof runner.imageOS !== 'string' ||
      !runner.imageOS ||
      typeof runner.imageVersion !== 'string' ||
      !runner.imageVersion)
  ) {
    throw new Error(
      'affected-native proof requires an exact hosted runner image',
    );
  }
  return toolchain;
}

export function nativeToolchainIdentity(toolchain, requireHosted = false) {
  validateNativeToolchain(toolchain, requireHosted);
  const { imageVersion: _imageVersion, ...runner } = toolchain.runner;
  return {
    compiler: toolchain.compiler,
    cmake: toolchain.cmake,
    ninja: toolchain.ninja,
    runner,
  };
}

export function validatePlan(plan) {
  if (plan?.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('unsupported affected-native plan schema');
  }
  const { planDigest, ...body } = plan;
  if (planDigest !== digest(body)) {
    throw new Error('affected-native plan digest drift');
  }
  requireSha(plan.base, 'affected-native base');
  requireSha(plan.head, 'affected-native head');
  return plan;
}

export function planProjection(plan) {
  validatePlan(plan);
  const {
    base: _base,
    head: _head,
    planDigest: _planDigest,
    ...projection
  } = plan;
  return projection;
}

function normalizeChangedPath(value) {
  const normalized = String(value || '').replace(/^\.\//u, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0')
  ) {
    throw new Error('affected-native semantic source path is invalid');
  }
  return normalized;
}

export function createSemanticSourceProjection(plan, entries = []) {
  validatePlan(plan);
  const changedPaths = sortedUnique(
    (plan.changedPaths || []).map(normalizeChangedPath),
  );
  const records = entries
    .map((entry) => {
      const pathName = normalizeChangedPath(entry?.path);
      if (entry?.state === 'deleted') {
        return { path: pathName, state: 'deleted' };
      }
      if (
        entry?.state !== 'present' ||
        !/^(100644|100755|120000|160000)$/u.test(entry.mode || '') ||
        !['blob', 'commit'].includes(entry.type) ||
        !/^[0-9a-f]{40}$/u.test(entry.objectId || '')
      ) {
        throw new Error(
          `affected-native semantic source entry is invalid: ${pathName}`,
        );
      }
      return {
        path: pathName,
        state: 'present',
        mode: entry.mode,
        type: entry.type,
        objectId: entry.objectId,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(records.map(({ path: pathName }) => pathName)).size !==
      records.length ||
    stableJson(records.map(({ path: pathName }) => pathName)) !==
      stableJson(changedPaths)
  ) {
    throw new Error(
      'affected-native semantic source entries do not match changed paths',
    );
  }
  const body = {
    schema: 'kungfu.affected-native-semantic-source/v1',
    changedPaths,
    entries: records,
  };
  return { ...body, semanticSourceRoot: digest(body) };
}

function gitBytes(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed`,
    );
  }
  return result.stdout;
}

export function semanticSourceProjectionFromGit(plan, cwd = process.cwd()) {
  validatePlan(plan);
  const changedPaths = gitBytes(
    ['diff', '--name-only', '-z', '--no-renames', plan.base, plan.head],
    cwd,
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath);
  const entries = changedPaths.map((pathName) => {
    const raw = gitBytes(['ls-tree', '-z', plan.head, '--', pathName], cwd)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    if (raw.length === 0) return { path: pathName, state: 'deleted' };
    if (raw.length !== 1) {
      throw new Error(
        `affected-native semantic source tree entry is ambiguous: ${pathName}`,
      );
    }
    const match = raw[0].match(
      /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u,
    );
    if (!match || normalizeChangedPath(match[4]) !== pathName) {
      throw new Error(
        `affected-native semantic source tree entry drift: ${pathName}`,
      );
    }
    return {
      path: pathName,
      state: 'present',
      mode: match[1],
      type: match[2],
      objectId: match[3],
    };
  });
  return createSemanticSourceProjection(plan, entries);
}

function qualificationIdentityFromIdentity(identity) {
  if (identity?.schema !== IDENTITY_SCHEMA) {
    throw new Error('affected-native qualification identity schema drift');
  }
  return {
    schema: QUALIFICATION_IDENTITY_SCHEMA,
    semanticSourceRoot: requireRoot(
      identity.semanticSourceRoot,
      'affected-native semantic source root',
    ),
    planProjectionDigest: identity.planProjectionDigest,
    partitionCount: identity.partitionCount,
    platformTier: identity.platformTier,
    toolchain: identity.toolchain,
    dependencyRoot: identity.dependencyRoot,
    closureRoot: identity.closureRoot,
  };
}

function intersect(left = [], right = []) {
  const rightSet = new Set(right);
  return [...new Set(left.filter((entry) => rightSet.has(entry)))].sort();
}

export function classifyProofBaseDelta({ descriptor, proofPlan, deltaPlan }) {
  validateCurrentDescriptor(descriptor);
  validatePlan(proofPlan);
  if (proofPlan.base === descriptor.identity.base) {
    return {
      action: 'reuse-source-qualification',
      reason: 'exact-qualified-base',
      reusable: true,
      changedPaths: [],
      overlappingComponents: [],
    };
  }
  if (!deltaPlan) {
    return {
      action: 'rerun-full-source-qualification',
      reason: 'dependency-attribution-unknown',
      reusable: false,
    };
  }
  validatePlan(deltaPlan);
  if (
    deltaPlan.base !== proofPlan.base ||
    deltaPlan.head !== descriptor.identity.base
  ) {
    return {
      action: 'rerun-full-source-qualification',
      reason: 'dev-delta-range-mismatch',
      reusable: false,
    };
  }
  const overlappingComponents = intersect(
    proofPlan.closureComponents,
    deltaPlan.closureComponents,
  );
  const sdkOverlap =
    proofPlan.sdkQualification?.required === true &&
    deltaPlan.sdkQualification?.required === true;
  if (overlappingComponents.length > 0 || sdkOverlap) {
    return {
      action: 'rerun-affected-source-shards',
      reason: 'dev-delta-overlaps-affected-closure',
      reusable: false,
      changedPaths: [...new Set(deltaPlan.changedPaths || [])].sort(),
      overlappingComponents,
      sdkOverlap,
    };
  }
  return {
    action: 'reuse-source-qualification',
    reason: 'unrelated-dev-delta',
    reusable: true,
    changedPaths: [...new Set(deltaPlan.changedPaths || [])].sort(),
    overlappingComponents: [],
    requiredFinalGate: 'exact-merge-group-integration',
  };
}

function validateCurrentDescriptor(descriptor) {
  if (
    descriptor?.schema !== DESCRIPTOR_SCHEMA ||
    descriptor.identity?.schema !== IDENTITY_SCHEMA
  ) {
    throw new Error('affected-native proof descriptor schema drift');
  }
  const binding = validateDeliveryBinding(descriptor.identity.deliveryBinding);
  if (
    binding.state === 'bound' &&
    (binding.source.devHead !== descriptor.identity.base ||
      binding.source.replayedTree !== descriptor.identity.sourceTree)
  ) {
    throw new Error('affected-native descriptor delivery source drift');
  }
  const qualificationIdentity = qualificationIdentityFromIdentity(
    descriptor.identity,
  );
  if (
    stableJson(descriptor.qualificationIdentity) !==
    stableJson(qualificationIdentity)
  ) {
    throw new Error('affected-native qualification identity projection drift');
  }
  const proofId = digest(qualificationIdentity).slice('sha256:'.length);
  if (
    descriptor.proofId !== proofId ||
    descriptor.artifactName !== `core-affected-native-proof-${proofId}`
  ) {
    throw new Error('affected-native qualification proof id drift');
  }
  return qualificationIdentity;
}

export function createProofDescriptor(
  plan,
  sourceTree,
  partitionCount,
  toolchain,
  deliveryBinding = null,
  semanticSourceRoot = null,
) {
  requireSha(sourceTree, 'affected-native source tree');
  if (
    !Number.isInteger(partitionCount) ||
    partitionCount < 1 ||
    partitionCount > 8
  ) {
    throw new Error('partition count must be an integer from 1 to 8');
  }
  const projection = planProjection(plan);
  const nativeRequired =
    plan.platformTier === 'github-hosted-linux-native-pr' &&
    plan.closureComponents.length > 0;
  validateNativeToolchain(toolchain, nativeRequired);
  const exactSemanticSourceRoot = requireRoot(
    semanticSourceRoot ||
      digest({
        schema: 'kungfu.affected-native-semantic-source-fallback/v1',
        sourceTree,
        changedPaths: sortedUnique(plan.changedPaths || []),
      }),
    'affected-native semantic source root',
  );
  const dependencyRoot = digest({
    semanticSourceRoot: exactSemanticSourceRoot,
    authority: projection.authority,
  });
  const closureRoot = digest({
    components: projection.closureComponents,
    targets: projection.targets,
    tests: projection.tests,
  });
  const sharedIdentity = {
    base: plan.base,
    sourceTree,
    semanticSourceRoot: exactSemanticSourceRoot,
    planProjectionDigest: digest(projection),
    partitionCount,
    platformTier: plan.platformTier,
    toolchain: nativeToolchainIdentity(toolchain, nativeRequired),
  };
  const identity = deliveryBinding
    ? {
        schema: IDENTITY_SCHEMA,
        ...sharedIdentity,
        dependencyRoot,
        closureRoot,
        deliveryBinding: validateDeliveryBinding(deliveryBinding),
      }
    : {
        schema: LEGACY_IDENTITY_SCHEMA,
        ...sharedIdentity,
      };
  const qualificationIdentity = deliveryBinding
    ? qualificationIdentityFromIdentity(identity)
    : null;
  const proofId = digest(qualificationIdentity || identity).slice(
    'sha256:'.length,
  );
  const descriptor = {
    schema: deliveryBinding ? DESCRIPTOR_SCHEMA : LEGACY_DESCRIPTOR_SCHEMA,
    identity,
    ...(qualificationIdentity ? { qualificationIdentity } : {}),
    proofId,
    artifactName: `core-affected-native-proof-${proofId}`,
    nativeRequired,
    sdkRequired: plan.sdkQualification?.required === true,
  };
  if (deliveryBinding) validateCurrentDescriptor(descriptor);
  return descriptor;
}

function expectedPartition(plan, count, index) {
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error('affected-native partition count is invalid');
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error('affected-native partition index is invalid');
  }
  const lanes = Array.from({ length: count }, (_, laneIndex) => {
    const targets = plan.targets.filter(
      (_target, targetIndex) => targetIndex % count === laneIndex,
    );
    const targetSet = new Set(targets);
    return {
      index: laneIndex,
      targets,
      tests: plan.tests.filter((test) => targetSet.has(test)),
    };
  });
  const selected = lanes[index];
  return {
    schema: 'kungfu.core-affected-native-partition/v1',
    index,
    count,
    targets: selected.targets,
    tests: selected.tests,
    partitionDigest: digest({
      planDigest: plan.planDigest,
      index,
      count,
      targets: selected.targets,
      tests: selected.tests,
    }),
    coverageDigest: digest({ planDigest: plan.planDigest, count, lanes }),
  };
}

export function validateCoreReceipt(receipt, descriptor) {
  if (receipt?.schema !== 'kungfu.core-affected-native-receipt/v1') {
    throw new Error('unsupported affected-native receipt schema');
  }
  validatePlan(receipt.plan);
  if (receipt.status !== 'passed') {
    throw new Error('affected-native receipt is not passed');
  }
  if (
    receipt.planDigest !== receipt.plan.planDigest ||
    receipt.source?.base !== receipt.plan.base ||
    receipt.source?.head !== receipt.plan.head
  ) {
    throw new Error('affected-native receipt source or plan binding drift');
  }
  if (
    digest(planProjection(receipt.plan)) !==
    descriptor.identity.planProjectionDigest
  ) {
    throw new Error('affected-native receipt plan projection drift');
  }
  const partition = receipt.executionPartition;
  const expected = expectedPartition(
    receipt.plan,
    descriptor.identity.partitionCount,
    partition?.index,
  );
  if (stableJson(partition) !== stableJson(expected)) {
    throw new Error('affected-native receipt partition drift');
  }
  if (descriptor.nativeRequired) {
    if (receipt.platform !== 'linux-x64') {
      throw new Error('affected-native proof requires linux-x64 receipts');
    }
    validateNativeToolchain(receipt.toolchain, true);
    if (
      stableJson(nativeToolchainIdentity(receipt.toolchain, true)) !==
      stableJson(descriptor.identity.toolchain)
    ) {
      throw new Error('affected-native receipt toolchain identity drift');
    }
  }
  return receipt;
}

function receiptFiles(root) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = readJson(target);
          if (value?.schema === 'kungfu.core-affected-native-receipt/v1') {
            found.push({ file: target, value });
          }
        } catch {
          // Unrelated diagnostic JSON is not part of the proof surface.
        }
      }
    }
  };
  visit(root);
  return found;
}

function partitionRecords(descriptor, inputs) {
  const records = inputs.map(({ value }) => {
    const receipt = validateCoreReceipt(value, descriptor);
    return {
      index: receipt.executionPartition.index,
      count: receipt.executionPartition.count,
      receiptDigest: digest(receipt),
      planDigest: receipt.planDigest,
      partitionDigest: receipt.executionPartition.partitionDigest,
      coverageDigest: receipt.executionPartition.coverageDigest,
      platform: receipt.platform,
      toolchain: receipt.toolchain,
    };
  });
  records.sort((left, right) => left.index - right.index);
  const expectedIndexes = Array.from(
    { length: descriptor.identity.partitionCount },
    (_value, index) => index,
  );
  if (
    records.length !== expectedIndexes.length ||
    stableJson(records.map(({ index }) => index)) !==
      stableJson(expectedIndexes)
  ) {
    throw new Error('affected-native proof partition set is incomplete');
  }
  if (new Set(records.map(({ coverageDigest }) => coverageDigest)).size !== 1) {
    throw new Error('affected-native proof partition coverage drift');
  }
  return records;
}

export function sealProof(descriptor, inputDir, producer) {
  const inputs = receiptFiles(inputDir);
  const partitions = partitionRecords(descriptor, inputs);
  const checkoutHeads = new Set(inputs.map(({ value }) => value.plan.head));
  if (checkoutHeads.size !== 1 || !checkoutHeads.has(producer.checkoutSha)) {
    throw new Error('affected-native proof producer checkout drift');
  }
  const current = descriptor.identity?.schema === IDENTITY_SCHEMA;
  const proofIdentity = current
    ? validateCurrentDescriptor(descriptor)
    : descriptor.identity;
  const proof = {
    schema: current ? PROOF_SCHEMA : LEGACY_PROOF_SCHEMA,
    ...(current
      ? { qualificationIdentity: proofIdentity }
      : { identity: proofIdentity }),
    proofId: descriptor.proofId,
    artifactName: descriptor.artifactName,
    producer: {
      repository: producer.repository,
      runId: Number(producer.runId),
      event: producer.event,
      workflowPath: producer.workflowPath,
      triggerHeadSha: requireSha(producer.triggerHeadSha, 'producer trigger'),
      checkoutSha: requireSha(producer.checkoutSha, 'producer checkout'),
      createdAt: producer.createdAt,
    },
    partitions,
    verdict: {
      status: 'passed',
      nativeRequired: descriptor.nativeRequired,
      sdkRequired: descriptor.sdkRequired,
    },
  };
  return { ...proof, proofRoot: digest(proof) };
}

function validateProducer(producer, options) {
  if (
    !PRODUCER_EVENTS.has(options.producerEvent) ||
    producer.repository !== options.repository ||
    producer.event !== options.producerEvent ||
    producer.workflowPath !== WORKFLOW_PATH ||
    producer.runId !== Number(options.producerRunId) ||
    producer.triggerHeadSha !== options.producerHeadSha ||
    (producer.event === 'merge_group' &&
      producer.checkoutSha !== producer.triggerHeadSha)
  ) {
    throw new Error('affected-native proof producer authority drift');
  }
  const created = new Date(producer.createdAt).getTime();
  const now = new Date(options.now || Date.now()).getTime();
  const age = (now - created) / 1000;
  if (!Number.isFinite(created) || age < -300 || age > options.maxAgeSeconds) {
    throw new Error('affected-native proof is outside the freshness window');
  }
}

export function verifyProofBundle(descriptor, bundleDir, options) {
  const proof = readJson(path.join(bundleDir, 'proof.json'));
  const { proofRoot, ...body } = proof;
  const current = descriptor.identity?.schema === IDENTITY_SCHEMA;
  const expectedIdentity = current
    ? validateCurrentDescriptor(descriptor)
    : descriptor.identity;
  const expectedProofSchema = current ? PROOF_SCHEMA : LEGACY_PROOF_SCHEMA;
  if (proof.schema !== expectedProofSchema || proofRoot !== digest(body)) {
    throw new Error('affected-native proof root drift');
  }
  if (
    (current &&
      (proof.identity !== undefined ||
        stableJson(proof.qualificationIdentity) !==
          stableJson(expectedIdentity))) ||
    (!current &&
      (proof.qualificationIdentity !== undefined ||
        stableJson(proof.identity) !== stableJson(expectedIdentity))) ||
    proof.proofId !== descriptor.proofId ||
    proof.artifactName !== descriptor.artifactName
  ) {
    throw new Error('affected-native proof identity drift');
  }
  validateProducer(proof.producer, options);
  const inputs = receiptFiles(bundleDir);
  const proofPlans = inputs.map(({ value }) => value.plan);
  if (proofPlans.length === 0) {
    throw new Error('affected-native proof partition set is incomplete');
  }
  const proofPlan = proofPlans[0];
  if (proofPlans.some((plan) => plan.planDigest !== proofPlan.planDigest)) {
    throw new Error('affected-native proof plan set drift');
  }
  const baseDelta = current
    ? classifyProofBaseDelta({
        descriptor,
        proofPlan,
        deltaPlan: options.deltaPlan || null,
      })
    : {
        action: 'reuse-source-qualification',
        reason: 'legacy-exact-proof',
        reusable: true,
        changedPaths: [],
        overlappingComponents: [],
      };
  if (!baseDelta.reusable) {
    throw new Error(
      `affected-native source proof reuse rejected: ${baseDelta.reason}`,
    );
  }
  const records = partitionRecords(descriptor, inputs);
  if (stableJson(records) !== stableJson(proof.partitions)) {
    throw new Error('affected-native proof receipt set drift');
  }
  if (
    proof.verdict?.status !== 'passed' ||
    proof.verdict.nativeRequired !== descriptor.nativeRequired ||
    proof.verdict.sdkRequired !== descriptor.sdkRequired
  ) {
    throw new Error('affected-native proof verdict drift');
  }
  return { ...proof, baseDelta };
}

export function createDeliveryAttempt(descriptor, proof, decision, producer) {
  if (!['fresh', 'reused'].includes(decision)) {
    throw new Error('affected-native proof decision is invalid');
  }
  const binding = validateDeliveryBinding(descriptor.identity?.deliveryBinding);
  if (binding.state !== 'bound') {
    throw new Error('delivery attempt requires a bound delivery');
  }
  const mergeGroupHead = requireSha(
    producer.triggerHeadSha,
    'delivery merge-group head',
  );
  if (binding.source.replayedCandidate !== mergeGroupHead) {
    throw new Error('delivery merge-group candidate drift');
  }
  const body = {
    schema: DELIVERY_ATTEMPT_SCHEMA,
    deliveryBindingRoot: binding.bindingRoot,
    source: {
      ...binding.source,
      mergeGroupHead,
      checkout: requireSha(producer.checkoutSha, 'delivery checkout'),
    },
    family: binding.family,
    requiredChecks: binding.requiredChecks,
    queueAdmission: binding.queueAdmission,
    proof: {
      decision,
      proofId: proof.proofId,
      proofRoot: requireRoot(proof.proofRoot, 'affected-native proof root'),
      producer: proof.producer,
    },
    workflow: {
      repository: requireRepository(producer.repository, 'delivery repository'),
      runId: requireRunId(producer.runId, 'delivery run id'),
      event: producer.event,
      workflowPath: WORKFLOW_PATH,
      runner: descriptor.identity.toolchain.runner,
    },
  };
  if (body.workflow.event !== 'merge_group') {
    throw new Error('delivery attempt must be emitted by merge_group');
  }
  return { ...body, attemptRoot: digest(body) };
}

export function validateDeliveryAttempt(attempt) {
  const { attemptRoot, ...body } = attempt || {};
  if (body.schema !== DELIVERY_ATTEMPT_SCHEMA || attemptRoot !== digest(body)) {
    throw new Error('affected-native delivery attempt root drift');
  }
  if (
    body.workflow?.event !== 'merge_group' ||
    body.workflow?.workflowPath !== WORKFLOW_PATH ||
    !['fresh', 'reused'].includes(body.proof?.decision)
  ) {
    throw new Error('affected-native delivery attempt authority drift');
  }
  requireSha(body.source?.pullRequestHead, 'delivery pull request head');
  requireSha(body.source?.devHead, 'delivery dev head');
  requireSha(body.source?.replayedCandidate, 'delivery replayed candidate');
  requireSha(body.source?.replayedTree, 'delivery replayed tree');
  requireSha(body.source?.mergeGroupHead, 'delivery merge-group head');
  requireSha(body.source?.checkout, 'delivery checkout');
  if (
    body.source.checkout !== body.source.mergeGroupHead ||
    body.source.replayedCandidate !== body.source.mergeGroupHead
  ) {
    throw new Error('affected-native delivery checkout drift');
  }
  requireRoot(
    body.deliveryBindingRoot,
    'affected-native delivery binding root',
  );
  const contexts = normalizedContexts(body.requiredChecks?.contexts);
  if (
    body.requiredChecks?.root !== digest({ contexts }) ||
    body.queueAdmission?.state !== 'success'
  ) {
    throw new Error('affected-native delivery admission binding drift');
  }
  if (body.family === null) {
    if (body.queueAdmission?.familyLeaseState !== 'not-applicable') {
      throw new Error('affected-native non-family delivery binding drift');
    }
  } else {
    requireIdentifier(body.family?.initiativeId, 'family initiative id');
    requireIdentifier(body.family?.assignmentId, 'family assignment id');
    requireIdentifier(body.family?.deliveryClass, 'family delivery class');
    requireQueueAttempt(body.family?.queueAttempt);
    requireRoot(body.family?.leaseRoot, 'family lease root');
    requireRoot(
      body.family?.admissionProofRoot,
      'family replay admission proof root',
    );
    for (const root of body.family?.admissionProofRoots || []) {
      requireRoot(root, 'family admission proof root');
    }
    requireContext(body.family?.statusContext, 'family status context');
    if (body.queueAdmission?.familyLeaseState !== 'pending') {
      throw new Error('affected-native delivery admission binding drift');
    }
  }
  requireContext(body.queueAdmission?.context, 'queue admission context');
  requireRoot(body.queueAdmission?.root, 'queue admission root');
  requireRoot(body.proof?.proofRoot, 'affected-native proof root');
  requireIdentifier(body.proof?.proofId, 'affected-native proof id');
  const proofProducer = body.proof?.producer;
  requireRepository(
    proofProducer?.repository,
    'affected-native proof producer repository',
  );
  requireRunId(proofProducer?.runId, 'affected-native proof producer run id');
  if (
    !PRODUCER_EVENTS.has(proofProducer?.event) ||
    proofProducer?.workflowPath !== WORKFLOW_PATH
  ) {
    throw new Error('affected-native proof producer drift');
  }
  requireSha(
    proofProducer?.triggerHeadSha,
    'affected-native proof producer trigger',
  );
  requireSha(
    proofProducer?.checkoutSha,
    'affected-native proof producer checkout',
  );
  const repository = requireRepository(
    body.workflow?.repository,
    'delivery repository',
  );
  requireRunId(body.workflow?.runId, 'delivery run id');
  if (proofProducer.repository !== repository) {
    throw new Error('affected-native proof repository drift');
  }
  return attempt;
}

export function deliveryAttemptGithubOutputs(attempt) {
  return {
    'attempt-root': attempt.attemptRoot,
    'delivery-binding-root': attempt.deliveryBindingRoot,
    'family-lease-root': attempt.family?.leaseRoot || '',
    'delivery-class': attempt.family?.deliveryClass || '',
    'pull-request-head': attempt.source.pullRequestHead,
    'proof-decision': attempt.proof.decision,
  };
}

export function createCachePromotionAuthority(
  descriptor,
  proofBundleDir,
  options,
) {
  const target = {
    repository: requireRepository(
      options.targetRepository,
      'cache promotion target repository',
    ),
    runId: requireRunId(options.targetRunId, 'cache promotion target run id'),
    event: options.targetEvent,
    headSha: requireSha(options.targetHeadSha, 'cache promotion target head'),
    sourceTree: requireSha(
      options.targetSourceTree,
      'cache promotion target source tree',
    ),
  };
  if (target.event !== 'merge_group') {
    throw new Error('cache promotion target must be merge_group');
  }
  if (descriptor.identity?.sourceTree !== target.sourceTree) {
    throw new Error('cache promotion target source tree drift');
  }
  const proof = verifyProofBundle(descriptor, proofBundleDir, {
    repository: options.producerRepository,
    producerRunId: options.producerRunId,
    producerEvent: options.producerEvent,
    producerHeadSha: options.producerHeadSha,
    deltaPlan: options.deltaPlan || null,
    maxAgeSeconds:
      options.maxAgeSeconds === undefined
        ? DEFAULT_MAX_AGE_SECONDS
        : Number(options.maxAgeSeconds),
    now: options.now,
  });
  if (proof.producer.repository !== target.repository) {
    throw new Error('cache promotion producer repository drift');
  }
  const body = {
    schema: CACHE_PROMOTION_AUTHORITY_SCHEMA,
    target,
    proof: {
      proofId: proof.proofId,
      artifactName: proof.artifactName,
      proofRoot: proof.proofRoot,
    },
    devDeltaPlan: options.deltaPlan || null,
    producer: proof.producer,
    partitionCount: descriptor.identity.partitionCount,
    planProjectionDigest: descriptor.identity.planProjectionDigest,
    deliveryBindingRoot:
      descriptor.identity.deliveryBinding?.bindingRoot || null,
    payloadSourceSha: proof.producer.checkoutSha,
  };
  return { ...body, authorityDigest: digest(body) };
}

export function verifyCachePromotionAuthority(authorityDir, options) {
  const authority = readJson(path.join(authorityDir, 'authority.json'));
  const deltaPlan = authority.devDeltaPlan || null;
  const { authorityDigest, ...body } = authority;
  if (
    authority.schema !== CACHE_PROMOTION_AUTHORITY_SCHEMA ||
    authorityDigest !== digest(body)
  ) {
    throw new Error('cache promotion authority digest drift');
  }
  const expectedTarget = {
    repository: requireRepository(
      options.targetRepository,
      'cache promotion target repository',
    ),
    runId: requireRunId(options.targetRunId, 'cache promotion target run id'),
    event: 'merge_group',
    headSha: requireSha(options.targetHeadSha, 'cache promotion target head'),
    sourceTree: requireSha(
      options.targetSourceTree,
      'cache promotion target source tree',
    ),
  };
  if (stableJson(authority.target) !== stableJson(expectedTarget)) {
    throw new Error('cache promotion target authority drift');
  }
  const descriptor = readJson(path.join(authorityDir, 'descriptor.json'));
  if (
    descriptor.identity?.sourceTree !== expectedTarget.sourceTree ||
    authority.partitionCount !== descriptor.identity?.partitionCount ||
    authority.planProjectionDigest !==
      descriptor.identity?.planProjectionDigest ||
    authority.deliveryBindingRoot !==
      (descriptor.identity?.deliveryBinding?.bindingRoot || null)
  ) {
    throw new Error('cache promotion descriptor authority drift');
  }
  const proof = verifyProofBundle(
    descriptor,
    path.join(authorityDir, 'proof'),
    {
      repository: authority.producer?.repository,
      producerRunId: authority.producer?.runId,
      producerEvent: authority.producer?.event,
      producerHeadSha: authority.producer?.triggerHeadSha,
      deltaPlan,
      maxAgeSeconds:
        options.maxAgeSeconds === undefined
          ? DEFAULT_MAX_AGE_SECONDS
          : Number(options.maxAgeSeconds),
      now: options.now,
    },
  );
  if (
    authority.proof?.proofId !== proof.proofId ||
    authority.proof?.artifactName !== proof.artifactName ||
    authority.proof?.proofRoot !== proof.proofRoot ||
    stableJson(authority.producer) !== stableJson(proof.producer) ||
    authority.payloadSourceSha !== proof.producer.checkoutSha
  ) {
    throw new Error('cache promotion proof authority drift');
  }
  return authority;
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`);
    options[argument.slice(2)] = rest[++index];
  }
  return options;
}

function appendGithubOutput(file, values) {
  if (!file) return;
  fs.appendFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'source-input') {
    const receipt = readJson(path.resolve(options['native-receipt']));
    const result = createSourceQualificationInput({
      repository: options.repository,
      protectedBase: options['protected-base'],
      pullRequestNumber: options['pull-request'],
      sourceHeadSha: options['source-head'],
      descriptor: readJson(path.resolve(options.descriptor)),
      proof: readJson(path.resolve(options.proof)),
      plan: receipt.plan,
    });
    writeJson(path.resolve(options.output), result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.command === 'queue-lease-verify') {
    const result = verifyQueueAdmissionLease({
      view: readJson(path.resolve(options.view)),
      pullRequestNumber: options['pull-request'],
      sourceHeadSha: options['source-head'],
      now: options.now,
    });
    writeJson(path.resolve(options.output), result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.command === 'integration-input') {
    const result = createIntegrationDeliveryInput({
      view: readJson(path.resolve(options.view)),
      deliveryAttempt: readJson(path.resolve(options['delivery-attempt'])),
      queueEntry: readJson(path.resolve(options['queue-entry'])),
      queueLeaseReceipt: readJson(path.resolve(options['queue-lease-receipt'])),
      pullRequestNumber: options['pull-request'],
      verifiedAt: options['verified-at'],
    });
    writeJson(path.resolve(options.output), result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.command === 'toolchain') {
    writeJson(
      path.resolve(options.output),
      observeNativeToolchain(process.env, { compiler: options.compiler }),
    );
    return;
  }
  if (options.command === 'describe') {
    const plan = readJson(path.resolve(options.plan));
    const deliveryBinding = options['delivery-binding']
      ? readJson(path.resolve(options['delivery-binding']))
      : null;
    const semanticSource = semanticSourceProjectionFromGit(plan);
    const descriptor = createProofDescriptor(
      plan,
      options['source-tree'] || git('rev-parse', 'HEAD^{tree}'),
      Number(options['partition-count'] || 2),
      readJson(path.resolve(options.toolchain)),
      deliveryBinding,
      semanticSource.semanticSourceRoot,
    );
    writeJson(path.resolve(options.output), descriptor);
    appendGithubOutput(options['github-output'], {
      'proof-id': descriptor.proofId,
      'artifact-name': descriptor.artifactName,
      'native-required': descriptor.nativeRequired,
      'sdk-required': descriptor.sdkRequired,
    });
    console.log(JSON.stringify(descriptor, null, 2));
    return;
  }
  if (options.command === 'bind-delivery') {
    const rules = readJson(path.resolve(options['rules-file']));
    const binding = createDeliveryBinding({
      event: options.event,
      pullRequest: options['pull-request'],
      pullRequestHead: options['pull-request-head'],
      devHead: options['dev-head'],
      candidateHead: options['candidate-head'],
      candidateTree: options['candidate-tree'],
      pullRequestBody: fs.readFileSync(
        path.resolve(options['pr-body']),
        'utf8',
      ),
      combinedStatus: readJson(path.resolve(options['status-file'])),
      requiredContexts: requiredContextsFromRules(rules),
      queueAdmissionContext: options['queue-admission-context'],
    });
    writeJson(path.resolve(options.output), binding);
    appendGithubOutput(options['github-output'], {
      'binding-root': binding.bindingRoot,
      'binding-state': binding.state,
    });
    console.log(JSON.stringify(binding, null, 2));
    return;
  }
  if (options.command === 'lookup') {
    const descriptor = readJson(path.resolve(options.descriptor));
    let result;
    try {
      result = await lookupReusableArtifact({
        apiUrl: options['api-url'],
        repository: options.repository,
        artifactName: descriptor.artifactName,
        headSha: options['head-sha'],
        token: process.env.GITHUB_TOKEN || '',
        maxAgeSeconds: Number(
          options['max-age-seconds'] || DEFAULT_MAX_AGE_SECONDS,
        ),
      });
    } catch (error) {
      result = { reusable: false, reason: error.message, candidateCount: 0 };
    }
    appendGithubOutput(options['github-output'], {
      'run-id': result.reusable ? result.runId : '',
      'producer-event': result.reusable ? result.producerEvent : '',
      'producer-head-sha': result.reusable ? result.producerHeadSha : '',
      reusable: result.reusable,
      reason: result.reason,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.command === 'seal') {
    const descriptor = readJson(path.resolve(options.descriptor));
    const inputDir = path.resolve(options['input-dir']);
    const outputDir = path.resolve(options['output-dir']);
    const proof = sealProof(descriptor, inputDir, {
      repository: options.repository,
      runId: options['run-id'],
      event: options.event,
      workflowPath: WORKFLOW_PATH,
      triggerHeadSha: options['trigger-head-sha'],
      checkoutSha: options['checkout-sha'] || git('rev-parse', 'HEAD'),
      createdAt: options['created-at'] || new Date().toISOString(),
    });
    fs.mkdirSync(outputDir, { recursive: true });
    const inputs = receiptFiles(inputDir);
    for (const { value } of inputs) {
      writeJson(
        path.join(
          outputDir,
          `partition-${value.executionPartition.index}.receipt.json`,
        ),
        value,
      );
    }
    writeJson(path.join(outputDir, 'proof.json'), proof);
    console.log(JSON.stringify(proof, null, 2));
    return;
  }
  if (options.command === 'verify') {
    const proof = verifyProofBundle(
      readJson(path.resolve(options.descriptor)),
      path.resolve(options.bundle),
      {
        repository: options.repository,
        producerRunId: options['producer-run-id'],
        producerEvent: options['producer-event'],
        producerHeadSha: options['producer-head-sha'],
        maxAgeSeconds: Number(
          options['max-age-seconds'] || DEFAULT_MAX_AGE_SECONDS,
        ),
        now: options.now,
        deltaPlan: options['dev-delta-plan']
          ? readJson(path.resolve(options['dev-delta-plan']))
          : null,
      },
    );
    console.log(
      JSON.stringify(
        {
          status: 'verified',
          proofId: proof.proofId,
          proofRoot: proof.proofRoot,
          baseDelta: proof.baseDelta,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.command === 'seal-cache-authority') {
    const descriptorFile = path.resolve(options.descriptor);
    const proofBundleDir = path.resolve(options.bundle);
    const outputDir = path.resolve(options['output-dir']);
    const authority = createCachePromotionAuthority(
      readJson(descriptorFile),
      proofBundleDir,
      {
        targetRepository: options.repository,
        targetRunId: options['target-run-id'],
        targetEvent: 'merge_group',
        targetHeadSha: options['target-head-sha'],
        targetSourceTree:
          options['target-source-tree'] || git('rev-parse', 'HEAD^{tree}'),
        producerRepository: options.repository,
        producerRunId: options['producer-run-id'],
        producerEvent: options['producer-event'],
        producerHeadSha: options['producer-head-sha'],
        deltaPlan: options['dev-delta-plan']
          ? readJson(path.resolve(options['dev-delta-plan']))
          : null,
        maxAgeSeconds: Number(
          options['max-age-seconds'] || DEFAULT_MAX_AGE_SECONDS,
        ),
        now: options.now,
      },
    );
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(descriptorFile, path.join(outputDir, 'descriptor.json'));
    copyDirectory(proofBundleDir, path.join(outputDir, 'proof'));
    writeJson(path.join(outputDir, 'authority.json'), authority);
    console.log(JSON.stringify(authority, null, 2));
    return;
  }
  if (options.command === 'verify-cache-authority') {
    const authority = verifyCachePromotionAuthority(
      path.resolve(options.bundle),
      {
        targetRepository: options.repository,
        targetRunId: options['target-run-id'],
        targetHeadSha: options['target-head-sha'],
        targetSourceTree:
          options['target-source-tree'] || git('rev-parse', 'HEAD^{tree}'),
        maxAgeSeconds: Number(
          options['max-age-seconds'] || DEFAULT_MAX_AGE_SECONDS,
        ),
        now: options.now,
      },
    );
    appendGithubOutput(options['github-output'], {
      'authority-digest': authority.authorityDigest,
      'producer-run-id': authority.producer.runId,
      'producer-event': authority.producer.event,
      'producer-trigger-head-sha': authority.producer.triggerHeadSha,
      'payload-source-sha': authority.payloadSourceSha,
      'delivery-binding-root': authority.deliveryBindingRoot || '',
    });
    console.log(
      JSON.stringify(
        {
          status: 'verified',
          authorityDigest: authority.authorityDigest,
          payloadSourceSha: authority.payloadSourceSha,
          producer: authority.producer,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.command === 'verify-attempt') {
    const attempt = validateDeliveryAttempt(
      readJson(
        path.join(path.resolve(options.bundle), 'delivery-attempt.json'),
      ),
    );
    const expected = {
      repository: requireRepository(options.repository, 'delivery repository'),
      runId: requireRunId(options['run-id'], 'delivery run id'),
      headSha: requireSha(options['head-sha'], 'delivery merge-group head'),
      sourceTree: requireSha(
        options['source-tree'] || git('rev-parse', 'HEAD^{tree}'),
        'delivery source tree',
      ),
    };
    if (
      attempt.workflow.repository !== expected.repository ||
      attempt.workflow.runId !== expected.runId ||
      attempt.source.mergeGroupHead !== expected.headSha ||
      attempt.source.checkout !== expected.headSha ||
      attempt.source.replayedTree !== expected.sourceTree
    ) {
      throw new Error('affected-native delivery attempt target drift');
    }
    appendGithubOutput(
      options['github-output'],
      deliveryAttemptGithubOutputs(attempt),
    );
    console.log(
      JSON.stringify(
        {
          status: 'verified',
          attemptRoot: attempt.attemptRoot,
          deliveryBindingRoot: attempt.deliveryBindingRoot,
          family: attempt.family,
          source: attempt.source,
          proofDecision: attempt.proof.decision,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.command === 'seal-attempt') {
    const descriptor = readJson(path.resolve(options.descriptor));
    const bundle = path.resolve(options.bundle);
    const untrustedProof = readJson(path.join(bundle, 'proof.json'));
    const proof = verifyProofBundle(descriptor, bundle, {
      repository: untrustedProof.producer?.repository,
      producerRunId: untrustedProof.producer?.runId,
      producerEvent: untrustedProof.producer?.event,
      producerHeadSha: untrustedProof.producer?.triggerHeadSha,
      maxAgeSeconds: Number(
        options['max-age-seconds'] || DEFAULT_MAX_AGE_SECONDS,
      ),
      now: options.now,
      deltaPlan: options['dev-delta-plan']
        ? readJson(path.resolve(options['dev-delta-plan']))
        : null,
    });
    const attempt = createDeliveryAttempt(descriptor, proof, options.decision, {
      repository: options.repository,
      runId: options['run-id'],
      event: options.event,
      triggerHeadSha: options['trigger-head-sha'],
      checkoutSha: options['checkout-sha'] || git('rev-parse', 'HEAD'),
    });
    const outputDir = path.resolve(options['output-dir']);
    fs.mkdirSync(outputDir, { recursive: true });
    writeJson(path.join(outputDir, 'delivery-attempt.json'), attempt);
    console.log(JSON.stringify(attempt, null, 2));
    return;
  }
  throw new Error(
    'usage: affected-native-proof.mjs <source-input|queue-lease-verify|integration-input|toolchain|bind-delivery|describe|lookup|seal|verify|seal-attempt|verify-attempt|seal-cache-authority|verify-cache-authority>',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`[affected-native-proof] ${error.message}`);
    process.exitCode = 1;
  }
}
