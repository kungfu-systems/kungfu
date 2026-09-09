#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { digest } from './affected-native-proof.mjs';
import { parseFamilyQueueLeaseMarker } from './project-cut-family-queue-lease.mjs';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function requireRoot(value, label) {
  if (!ROOT.test(value || ''))
    throw new Error(`${label} must be an exact root`);
  return value;
}

function requireSha(value, label) {
  if (!SHA.test(value || ''))
    throw new Error(`${label} must be an exact Git SHA`);
  return value;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

export function activeLeaseContextForPullRequest(pullRequest, sourceHead) {
  const lease = parseFamilyQueueLeaseMarker(pullRequest?.body || '');
  return lease?.pullRequestHead === sourceHead ? lease.statusContext : '';
}

export function createDevDeliveryWarrantInput({
  repository,
  pullRequest,
  descriptor,
  plan,
}) {
  if (descriptor?.schema !== 'kungfu.affected-native-proof-descriptor/v4') {
    throw new Error(
      'delivery Warrant input requires the base-independent proof descriptor',
    );
  }
  if (plan?.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('delivery Warrant input requires an affected-native plan');
  }
  const prNumber = Number(pullRequest?.number);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error('delivery Warrant input requires an exact pull request');
  }
  const sourceHead = requireSha(pullRequest.head?.sha, 'pull request head');
  if (
    descriptor.identity?.deliveryBinding?.source?.pullRequestHead !== sourceHead
  ) {
    throw new Error('delivery Warrant descriptor head drift');
  }
  if (
    descriptor.identity?.planProjectionDigest !==
    digest(
      (({ base: _base, head: _head, planDigest: _digest, ...rest }) => rest)(
        plan,
      ),
    )
  ) {
    throw new Error('delivery Warrant plan projection drift');
  }
  const family = descriptor.identity.deliveryBinding.family;
  const assignmentBinding = family
    ? { kind: 'initiative-family', id: family.assignmentId }
    : { kind: 'pull-request-delivery', repository, pullRequest: prNumber };
  const initiativeBinding = family
    ? { kind: 'initiative-family', id: family.initiativeId }
    : { kind: 'protected-dev-line', repository, branch: pullRequest.base?.ref };
  const sourceIdentity = {
    repository,
    protectedBase: pullRequest.base?.ref,
    pullRequest: prNumber,
    assignmentBinding,
  };
  const sourceTree = requireSha(descriptor.identity.sourceTree, 'source tree');
  const environmentRoot = digest({
    schema: 'kungfu.github-hosted-native-environment/v1',
    platformTier: descriptor.identity.platformTier,
    toolchain: descriptor.identity.toolchain,
  });
  const proofIdentityRoot = requireRoot(
    `sha256:${descriptor.proofId}`,
    'affected-native proof identity',
  );
  const body = {
    schema: 'kungfu.dev-delivery-warrant-input/v1',
    repository,
    protectedBase: pullRequest.base?.ref,
    pullRequestNumber: prNumber,
    sourceHead,
    assignmentRoot: digest(assignmentBinding),
    initiativeRoot: digest(initiativeBinding),
    sourceIdentityRoot: digest(sourceIdentity),
    sourcePatchRoot: digest({
      sourceTree,
      changedPaths: uniqueStrings(plan.changedPaths),
    }),
    planRoot: requireRoot(
      descriptor.identity.planProjectionDigest,
      'plan projection',
    ),
    closureRoot: requireRoot(descriptor.identity.closureRoot, 'closure'),
    dependencyRoot: requireRoot(
      descriptor.identity.dependencyRoot,
      'dependency',
    ),
    toolchainRoot: digest(descriptor.identity.toolchain),
    environmentRoot,
    affectedPaths: uniqueStrings(plan.changedPaths),
    shardEvidenceRoots: uniqueStrings([
      proofIdentityRoot,
      descriptor.identity.deliveryBinding.bindingRoot,
    ]).map((root) => requireRoot(root, 'shard evidence')),
    deliveryClass:
      family?.deliveryClass ||
      (descriptor.nativeRequired || descriptor.sdkRequired
        ? 'native-proof-required'
        : 'non-native-fast'),
    priority: 'ordinary',
  };
  return { ...body, inputRoot: digest(body) };
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (!entry.startsWith('--')) continue;
    result[entry.slice(2)] = args[index + 1] || '';
    index += 1;
  }
  return result;
}

function appendOutputs(file, value, activeLeaseContext = '') {
  if (!file) return;
  const outputs = {
    'assignment-root': value.assignmentRoot,
    'initiative-root': value.initiativeRoot,
    'source-identity-root': value.sourceIdentityRoot,
    'source-patch-root': value.sourcePatchRoot,
    'plan-root': value.planRoot,
    'closure-root': value.closureRoot,
    'dependency-root': value.dependencyRoot,
    'toolchain-root': value.toolchainRoot,
    'environment-root': value.environmentRoot,
    'affected-paths-json': JSON.stringify(value.affectedPaths),
    'shard-evidence-roots-json': JSON.stringify(value.shardEvidenceRoots),
    'delivery-class': value.deliveryClass,
    priority: value.priority,
    'input-root': value.inputRoot,
    'active-lease-context': activeLeaseContext,
  };
  fs.appendFileSync(
    file,
    `${Object.entries(outputs)
      .map(([key, entry]) => `${key}=${entry}`)
      .join('\n')}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const pullRequest = readJson(options['pull-request']);
    const result = createDevDeliveryWarrantInput({
      repository: options.repository,
      pullRequest,
      descriptor: readJson(options.descriptor),
      plan: readJson(options.plan),
    });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    appendOutputs(
      options['github-output'],
      result,
      activeLeaseContextForPullRequest(pullRequest, result.sourceHead),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
