#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const IDENTITY_SCHEMA = 'kungfu.affected-native-proof-identity/v3';
export const PROOF_SCHEMA = 'kungfu.affected-native-proof/v3';
export const CACHE_PROMOTION_AUTHORITY_SCHEMA =
  'kungfu.affected-native-cache-promotion-authority/v1';
export const WORKFLOW_PATH = '.github/workflows/affected-native-pr.yml';
export const DEFAULT_MAX_AGE_SECONDS = 6 * 60 * 60;
const PRODUCER_EVENTS = new Set(['pull_request', 'merge_group']);

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(value || '')) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return value;
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
  const { head: _head, planDigest: _planDigest, ...projection } = plan;
  return projection;
}

export function createProofDescriptor(
  plan,
  sourceTree,
  partitionCount,
  toolchain,
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
  const identity = {
    schema: IDENTITY_SCHEMA,
    base: plan.base,
    sourceTree,
    planProjectionDigest: digest(projection),
    partitionCount,
    platformTier: plan.platformTier,
    toolchain: nativeToolchainIdentity(toolchain, nativeRequired),
  };
  const proofId = digest(identity).slice('sha256:'.length);
  return {
    schema: 'kungfu.affected-native-proof-descriptor/v1',
    identity,
    proofId,
    artifactName: `core-affected-native-proof-${proofId}`,
    nativeRequired,
    sdkRequired: plan.sdkQualification?.required === true,
  };
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
  const proof = {
    schema: PROOF_SCHEMA,
    identity: descriptor.identity,
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
  if (proof.schema !== PROOF_SCHEMA || proofRoot !== digest(body)) {
    throw new Error('affected-native proof root drift');
  }
  if (
    stableJson(proof.identity) !== stableJson(descriptor.identity) ||
    proof.proofId !== descriptor.proofId ||
    proof.artifactName !== descriptor.artifactName
  ) {
    throw new Error('affected-native proof identity drift');
  }
  validateProducer(proof.producer, options);
  const records = partitionRecords(descriptor, receiptFiles(bundleDir));
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
  return proof;
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
    producer: proof.producer,
    partitionCount: descriptor.identity.partitionCount,
    planProjectionDigest: descriptor.identity.planProjectionDigest,
    payloadSourceSha: proof.producer.checkoutSha,
  };
  return { ...body, authorityDigest: digest(body) };
}

export function verifyCachePromotionAuthority(authorityDir, options) {
  const authority = readJson(path.join(authorityDir, 'authority.json'));
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
    authority.planProjectionDigest !== descriptor.identity?.planProjectionDigest
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

export function selectReusableArtifact({
  artifacts,
  runsById,
  artifactName,
  repositoryId,
  headSha,
  now = Date.now(),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  requireSha(headSha, 'consumer head');
  const candidates = artifacts.filter((artifact) => {
    const run = runsById.get(Number(artifact.workflow_run?.id));
    const age =
      (new Date(now).getTime() - new Date(artifact.created_at).getTime()) /
      1000;
    return (
      artifact.name === artifactName &&
      artifact.expired === false &&
      artifact.workflow_run?.repository_id === repositoryId &&
      artifact.workflow_run?.head_repository_id === repositoryId &&
      Number.isFinite(age) &&
      age >= -300 &&
      age <= maxAgeSeconds &&
      PRODUCER_EVENTS.has(run?.event) &&
      (run.event === 'pull_request' || run.head_sha === headSha) &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.path === WORKFLOW_PATH
    );
  });
  if (candidates.length === 0) {
    return {
      reusable: false,
      reason: 'no exact trusted producer proof artifact',
      candidateCount: 0,
    };
  }
  const selected = [...candidates].sort((left, right) => {
    const createdAtOrder =
      new Date(right.created_at).getTime() -
      new Date(left.created_at).getTime();
    if (createdAtOrder !== 0) return createdAtOrder;
    const artifactIdOrder = Number(right.id) - Number(left.id);
    if (artifactIdOrder !== 0) return artifactIdOrder;
    return Number(right.workflow_run?.id) - Number(left.workflow_run?.id);
  })[0];
  const selectedRun = runsById.get(Number(selected.workflow_run.id));
  return {
    reusable: true,
    reason:
      candidates.length === 1
        ? 'exact trusted producer proof artifact found'
        : 'newest exact trusted producer proof artifact selected',
    candidateCount: candidates.length,
    runId: Number(selected.workflow_run.id),
    artifactId: Number(selected.id),
    producerEvent: selectedRun.event,
    producerHeadSha: selectedRun.head_sha,
  };
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

export async function lookupReusableArtifact({
  apiUrl,
  repository,
  artifactName,
  headSha,
  token,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  const repositoryDocument = await githubJson(
    `${apiUrl}/repos/${repository}`,
    token,
  );
  const artifactDocument = await githubJson(
    `${apiUrl}/repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    token,
  );
  const artifacts = artifactDocument.artifacts || [];
  const runIds = [
    ...new Set(artifacts.map((artifact) => Number(artifact.workflow_run?.id))),
  ].filter(Number.isFinite);
  const runs = await Promise.all(
    runIds.map(async (runId) => [
      runId,
      await githubJson(
        `${apiUrl}/repos/${repository}/actions/runs/${runId}`,
        token,
      ),
    ]),
  );
  return selectReusableArtifact({
    artifacts,
    runsById: new Map(runs),
    artifactName,
    repositoryId: Number(repositoryDocument.id),
    headSha,
    maxAgeSeconds,
  });
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
  if (options.command === 'toolchain') {
    writeJson(
      path.resolve(options.output),
      observeNativeToolchain(process.env, { compiler: options.compiler }),
    );
    return;
  }
  if (options.command === 'describe') {
    const descriptor = createProofDescriptor(
      readJson(path.resolve(options.plan)),
      options['source-tree'] || git('rev-parse', 'HEAD^{tree}'),
      Number(options['partition-count'] || 2),
      readJson(path.resolve(options.toolchain)),
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
      },
    );
    console.log(
      JSON.stringify(
        {
          status: 'verified',
          proofId: proof.proofId,
          proofRoot: proof.proofRoot,
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
  throw new Error(
    'usage: affected-native-proof.mjs <toolchain|describe|lookup|seal|verify|seal-cache-authority|verify-cache-authority>',
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
