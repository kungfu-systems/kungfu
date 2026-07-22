#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicationAuthorityDigest,
  verifyPublicationAdmission,
} from '@kungfu-tech/buildchain/publication-authority';
import {
  kungfuBuildchainRuntimePolicy,
  validateKungfuGateAggregate,
} from './kungfu-release-qualification.mjs';
import {
  authorityDigest,
  validateWorkflowAuthority,
} from './kungfu-workflow-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = 'docs/qualification/gates/release-admission-policy.json';

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.resolve(root, relative), 'utf8'));
}

function requiredFile(value, label) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${label} path is required`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0'))
    throw new Error(`${label} fields must be exactly [${expected.join(', ')}]`);
}

function validatePolicy(root, policy) {
  exactKeys(
    policy,
    [
      'schema',
      'repository',
      'profile',
      'requiredPlatforms',
      'workflowAuthority',
      'buildchain',
      'publication',
      'freshness',
    ],
    'release admission policy',
  );
  if (policy.schema !== 'kungfu.release-admission-policy/v1')
    throw new Error('unsupported Kungfu release admission policy');
  if (
    !Array.isArray(policy.requiredPlatforms) ||
    policy.requiredPlatforms.join('\0') !== 'linux\0macos\0windows'
  )
    throw new Error(
      'Kungfu release admission requires linux, macos, and windows',
    );
  exactKeys(
    policy.workflowAuthority,
    ['manifest', 'workflow', 'job'],
    'workflowAuthority',
  );
  exactKeys(
    policy.buildchain,
    ['version', 'registry', 'runtimes'],
    'buildchain',
  );
  exactKeys(
    policy.publication,
    [
      'workflowPath',
      'publisherWorkflowPath',
      'environment',
      'product',
      'target',
      'channels',
    ],
    'publication',
  );
  exactKeys(
    policy.freshness,
    ['maximumLifetimeSeconds', 'nonceReplay'],
    'freshness',
  );
  if (
    policy.freshness.maximumLifetimeSeconds !== 900 ||
    policy.freshness.nonceReplay !== 'deny'
  )
    throw new Error(
      'Kungfu admission freshness must remain fail closed at 900 seconds',
    );
  if (
    !Array.isArray(policy.publication.channels) ||
    policy.publication.channels.length === 0 ||
    new Set(policy.publication.channels).size !==
      policy.publication.channels.length
  )
    throw new Error('publication.channels must be a non-empty unique array');
  const runtimeChannels = Object.keys(policy.buildchain.runtimes || {}).sort();
  if (
    runtimeChannels.join('\0') !==
    [...policy.publication.channels].sort().join('\0')
  )
    throw new Error(
      'Buildchain runtime channels must exactly match publication.channels',
    );
  for (const channel of policy.publication.channels) {
    const runtime = kungfuBuildchainRuntimePolicy(policy, channel);
    exactKeys(
      runtime,
      ['ref', 'runtimeSha', 'contractDigest', 'contractLock'],
      `buildchain.runtimes.${channel}`,
    );
    const lock = readJson(root, runtime.contractLock);
    if (
      lock?.buildchain?.ref !== runtime.ref ||
      lock?.buildchain?.resolvedSha !== runtime.runtimeSha ||
      lock?.buildchain?.contractDigest !== runtime.contractDigest
    )
      throw new Error(
        `Buildchain ${channel} runtime differs from its contract lock`,
      );
  }
}

function currentBuildchain(root, policy) {
  const releaseRuntime = kungfuBuildchainRuntimePolicy(policy, 'release');
  const packageDocument = readJson(
    root,
    'node_modules/@kungfu-tech/buildchain/package.json',
  );
  if (packageDocument.version !== policy.buildchain.version)
    throw new Error(
      'installed Buildchain version differs from release admission policy',
    );
  const contract = readJson(
    root,
    'node_modules/@kungfu-tech/buildchain/dist/site/buildchain-contract.json',
  );
  if (contract.contractDigest !== releaseRuntime.contractDigest)
    throw new Error(
      'installed Buildchain contract digest differs from release admission policy',
    );
  return readJson(root, policy.buildchain.registry);
}

function validateAuthorityJob(authorityDocument, policy) {
  const workflow = authorityDocument.workflows.find(
    (item) => item.path === policy.workflowAuthority.workflow,
  );
  const job = workflow?.jobs.find(
    (item) => item.id === policy.workflowAuthority.job,
  );
  if (!job)
    throw new Error('release admission authority job is not classified');
  if (
    job.authority !== 'release-control' ||
    job.publication !== 'channel' ||
    job.receipt !== 'qualifying'
  )
    throw new Error(
      'release admission authority job classification is not qualifying channel control',
    );
}

export function validateKungfuReleaseAdmissionPolicy(root = ROOT) {
  const policy = readJson(root, POLICY);
  validatePolicy(root, policy);
  const authority = validateWorkflowAuthority(root);
  if (authority.issues.length)
    throw new Error(
      `workflow authority is not closed: ${authority.issues.join('; ')}`,
    );
  validateAuthorityJob(authority.document, policy);
  const buildchainRegistry = currentBuildchain(root, policy);
  const descriptor = buildchainRegistry.entries?.find(
    (item) => item.workflowPath === policy.publication.workflowPath,
  );
  if (
    !descriptor ||
    descriptor.authorityClass !== 'product-publication' ||
    descriptor.publicationCapable !== true ||
    descriptor.publisherWorkflowMode !== 'caller-bound' ||
    descriptor.environment !== policy.publication.environment
  )
    throw new Error(
      'Buildchain registry does not authorize the configured sealed publication lane',
    );
  return { policy, authority: authority.document, buildchainRegistry };
}

export function verifyKungfuReleaseAdmission({
  root = ROOT,
  admission,
  runnerProvenance,
  controlPlaneAudit,
  publicationEvidence,
  expected,
  usedNonces = [],
  now = new Date(),
} = {}) {
  const validated = validateKungfuReleaseAdmissionPolicy(root);
  const { policy, authority, buildchainRegistry } = validated;
  const aggregate = publicationEvidence?.gateAggregate;
  validateKungfuGateAggregate(root, aggregate, policy);
  const runtime = kungfuBuildchainRuntimePolicy(policy, admission?.channel);

  const fixedBindings = {
    repository: policy.repository,
    publisherWorkflowPath: policy.publication.publisherWorkflowPath,
    runtimeSha: runtime.runtimeSha,
    contractDigest: runtime.contractDigest.replace(/^sha256:/, ''),
    environment: policy.publication.environment,
    product: policy.publication.product,
    target: policy.publication.target,
  };
  for (const [key, value] of Object.entries(fixedBindings))
    if (expected?.[key] !== value)
      throw new Error(
        `Kungfu release admission expected ${key} policy mismatch`,
      );
  if (!policy.publication.channels.includes(expected?.channel))
    throw new Error('Kungfu release admission channel is not allowed');
  if (admission?.workflowPath !== policy.publication.workflowPath)
    throw new Error(
      'Kungfu release admission workflow is not the sealed Buildchain authority',
    );
  if (expected?.policyDigest !== aggregate.matrixDigest)
    throw new Error(
      'Kungfu release admission policy digest differs from the Gate matrix',
    );

  const capability = verifyPublicationAdmission({
    admission,
    registry: buildchainRegistry,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence,
    expected,
    usedNonces,
    now,
  });
  const consumerPolicy = {
    policy,
    workflowAuthorityDigest: authorityDigest(authority),
    gateRegistryDigest: aggregate.registry.digest,
    gateMatrixDigest: aggregate.matrixDigest,
  };
  return {
    schema: 'kungfu.release-admission-capability/v1',
    qualifying: true,
    consumerPolicyDigest: publicationAuthorityDigest(consumerPolicy),
    capability,
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

function main() {
  const result = verifyKungfuReleaseAdmission({
    admission: readJson(ROOT, requiredFile(arg('admission'), 'admission')),
    runnerProvenance: readJson(
      ROOT,
      requiredFile(arg('runner-provenance'), 'runner provenance'),
    ),
    controlPlaneAudit: readJson(
      ROOT,
      requiredFile(arg('control-plane-audit'), 'control-plane audit'),
    ),
    publicationEvidence: readJson(
      ROOT,
      requiredFile(arg('publication-evidence'), 'publication evidence'),
    ),
    expected: readJson(ROOT, requiredFile(arg('expected'), 'expected')),
    usedNonces: arg('used-nonces') ? readJson(ROOT, arg('used-nonces')) : [],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
