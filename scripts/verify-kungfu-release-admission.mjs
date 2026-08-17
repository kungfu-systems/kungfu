#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_ARTIFACT,
  CATALOG_SOURCE,
  verifyPrimitiveCatalogIntegrity,
  verifyPrimitivePromotion,
} from './generate-primitive-catalog.mjs';
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

function normalizeDigest(value, label) {
  const digest = String(value || '')
    .replace(/^sha256:/, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0'))
    throw new Error(`${label} fields must be exactly [${expected.join(', ')}]`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${stableJson(value)}\n`)
    .digest('hex')}`;
}

export function temporalAdmissionFactProjection(root, policy) {
  const document = readJson(root, policy.temporalAdmission.admissionFacts);
  if (document?.schema !== 'kungfu.temporal-release-admission-fact-set/v1')
    throw new Error('unsupported temporal release admission fact set');
  const { factSetRoot, ...body } = document;
  if (factSetRoot !== contentRoot(body))
    throw new Error('temporal release admission fact-set root mismatch');
  const active = document.activeProofRoots;
  if (
    !Array.isArray(active) ||
    active.join('\0') !== [...new Set(active)].sort().join('\0')
  )
    throw new Error('temporal release admission active proof roots drift');
  const byRoot = new Map();
  for (const row of document.proofs || []) {
    if (row?.proofRoot !== contentRoot(row?.record))
      throw new Error('temporal release admission proof root mismatch');
    if (byRoot.has(row.proofRoot))
      throw new Error('temporal release admission proof root is ambiguous');
    byRoot.set(row.proofRoot, row.record);
  }
  if (
    active.length !== byRoot.size ||
    active.some((proofRoot) => !byRoot.has(proofRoot))
  )
    throw new Error('temporal release admission contains orphan proof entries');
  const channels = {};
  const proofRoots = {};
  for (const proofRoot of active) {
    const record = byRoot.get(proofRoot);
    if (record?.status !== 'active')
      throw new Error('temporal release admission selected an inactive proof');
    const channel = String(record.channel || '');
    const digest = `sha256:${normalizeDigest(
      record.acceptedContractDigest,
      'temporal accepted contract digest',
    )}`;
    channels[channel] ||= [];
    channels[channel].push(digest);
    proofRoots[channel] ||= {};
    if (proofRoots[channel][digest])
      throw new Error('temporal release admission binding is ambiguous');
    proofRoots[channel][digest] = proofRoot;
  }
  for (const channel of Object.keys(channels))
    channels[channel] = [...new Set(channels[channel])].sort();
  return { factSetRoot, channels, proofRoots };
}

function validateContractProjection(runtime, channel, temporalProjection) {
  const projection = runtime.contractProjection;
  exactKeys(
    projection,
    ['schema', 'authority', 'sourceFactSetRoot', 'entries', 'projectionRoot'],
    `buildchain.runtimes.${channel}.contractProjection`,
  );
  if (
    projection.schema !==
      'kungfu.temporal-release-admission-digest-projection/v1' ||
    projection.authority !== 'non-authoritative' ||
    projection.sourceFactSetRoot !== temporalProjection.factSetRoot
  )
    throw new Error(
      `Buildchain ${channel} contract projection is not a non-authoritative Fact projection`,
    );
  if (!Array.isArray(projection.entries) || projection.entries.length === 0)
    throw new Error(`Buildchain ${channel} contract projection is empty`);
  const expectedEntries = (temporalProjection.channels[channel] || []).map(
    (contractDigest) => ({
      contractDigest,
      sourceProofRoot: temporalProjection.proofRoots[channel]?.[contractDigest],
    }),
  );
  if (stableJson(projection.entries) !== stableJson(expectedEntries))
    throw new Error(
      `Buildchain ${channel} contract projection differs from active admission Facts`,
    );
  const { projectionRoot, ...body } = projection;
  if (projectionRoot !== contentRoot(body))
    throw new Error(`Buildchain ${channel} contract projection root mismatch`);
  return projection;
}

function publicationAuthorityDigest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
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
      'temporalAdmission',
    ],
    'release admission policy',
  );
  if (policy.schema !== 'kungfu.release-admission-policy/v1')
    throw new Error('unsupported Kungfu release admission policy');
  if (
    !Array.isArray(policy.requiredPlatforms) ||
    policy.requiredPlatforms.join('\0') !==
      'linux-x64\0linux-arm64\0macos-arm64\0windows-x64'
  )
    throw new Error(
      'Kungfu release admission requires linux-x64, linux-arm64, macos-arm64, and windows-x64',
    );
  exactKeys(
    policy.workflowAuthority,
    ['manifest', 'workflow', 'job'],
    'workflowAuthority',
  );
  exactKeys(
    policy.buildchain,
    [
      'version',
      'registry',
      'authorityRegistryDigest',
      'publicationAuthority',
      'runtimes',
    ],
    'buildchain',
  );
  exactKeys(
    policy.buildchain.publicationAuthority,
    [
      'workflowPath',
      'authorityClass',
      'publicationCapable',
      'publisherWorkflowMode',
      'environment',
    ],
    'buildchain.publicationAuthority',
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
  exactKeys(
    policy.temporalAdmission,
    [
      'contract',
      'admissionFacts',
      'compatibilityFacts',
      'releaseProvenanceContract',
    ],
    'temporalAdmission',
  );
  const temporalProjection = temporalAdmissionFactProjection(root, policy);
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
  if (
    !/^[0-9a-f]{64}$/.test(policy.buildchain.authorityRegistryDigest) ||
    policy.buildchain.publicationAuthority.workflowPath !==
      policy.publication.workflowPath ||
    policy.buildchain.publicationAuthority.authorityClass !==
      'product-publication' ||
    policy.buildchain.publicationAuthority.publicationCapable !== true ||
    policy.buildchain.publicationAuthority.publisherWorkflowMode !==
      'caller-bound' ||
    policy.buildchain.publicationAuthority.environment !==
      policy.publication.environment
  )
    throw new Error(
      'Buildchain publication authority consumer lock is not qualifying',
    );
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
      [
        'ref',
        'runtimeSha',
        'publicationRuntimeSha',
        'contractDigest',
        'packageContractDigest',
        'contractProjection',
        'contractLock',
        'packageVersion',
        'registry',
        'authorityRegistryDigest',
      ],
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
    validateContractProjection(runtime, channel, temporalProjection);
  }
}

export function verifyTemporalReleaseAdmission({
  root,
  policy,
  runtime,
  expected,
  publicationEvidence,
  temporalAdmission,
  consumerPolicyDigest,
} = {}) {
  if (!temporalAdmission?.releaseProvenance)
    throw new Error('temporal release admission provenance object is required');
  if ('KUNGFU_TEMPORAL_RELEASE_ADMISSION_MODE' in process.env)
    throw new Error(
      'temporal release admission mode cannot be selected from the environment',
    );
  const contract = readJson(root, policy.temporalAdmission.contract);
  const admissionFacts = readJson(
    root,
    policy.temporalAdmission.admissionFacts,
  );
  const compatibilityFacts = readJson(
    root,
    policy.temporalAdmission.compatibilityFacts,
  );
  const releaseProvenanceContract = readJson(
    root,
    policy.temporalAdmission.releaseProvenanceContract,
  );
  const request = {
    contract,
    admissionFacts,
    compatibilityFacts,
    releaseProvenanceContract,
    releaseProvenance: temporalAdmission.releaseProvenance,
    currentContractLock: readJson(root, runtime.contractLock),
    currentContractDigest: runtime.contractDigest,
    mode: contract.defaultMode,
    bindings: {
      repository: expected.repository,
      channel: expected.channel,
      sourceSha: expected.sourceSha,
      sourceTree: publicationEvidence.sourceTreeSha,
      promotionSha: temporalAdmission.promotionSha,
      artifactRoot: `sha256:${normalizeDigest(expected.artifactDigest, 'artifact digest')}`,
      runtimeSha: expected.runtimeSha,
      acceptedContractDigest: `sha256:${normalizeDigest(expected.contractDigest, 'contract digest')}`,
      qualificationRoot: temporalAdmission.qualificationRoot,
      approvalRoot:
        temporalAdmission.approvalRoot || `sha256:${consumerPolicyDigest}`,
      authorityRoot: temporalAdmission.authorityRoot,
    },
  };
  const pythonPath = path.join(root, 'framework/core/src/python');
  const result = childProcess.spawnSync(
    process.env.PYTHON || 'python3',
    [path.join(root, 'scripts/release-provenance-object.py'), 'admission'],
    {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify(request),
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH
          ? `${pythonPath}${path.delimiter}${process.env.PYTHONPATH}`
          : pythonPath,
      },
    },
  );
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(
      `temporal release admission verifier returned invalid JSON: ${String(result.stderr || '').trim()}`,
    );
  }
  if (result.status !== 0 || report.ok !== true) {
    const codes =
      report.receipt?.reasonCodes?.join(', ') || report.error || 'unknown';
    throw Object.assign(
      new Error(`temporal release admission rejected: ${codes}`),
      { receipt: report.receipt },
    );
  }
  if (
    report.receipt?.schema !== 'kungfu.temporal-release-admission-receipt/v1' ||
    report.receipt?.status !== 'accepted' ||
    report.receipt?.containsPrivatePayload !== false
  )
    throw new Error('temporal release admission receipt is not qualifying');
  return report.receipt;
}

function currentBuildchain(root, policy, channel) {
  const releaseRuntime = kungfuBuildchainRuntimePolicy(policy, channel);
  const packageName =
    channel === 'alpha'
      ? '@kungfu-tech/buildchain'
      : '@kungfu-tech/buildchain-stable';
  const packageVersion =
    releaseRuntime.packageVersion || policy.buildchain.version;
  const registryPath = releaseRuntime.registry || policy.buildchain.registry;
  const registryDigest =
    releaseRuntime.authorityRegistryDigest ||
    policy.buildchain.authorityRegistryDigest;
  const packageDocument = readJson(
    root,
    `node_modules/${packageName}/package.json`,
  );
  if (packageDocument.version !== packageVersion)
    throw new Error(
      'installed Buildchain version differs from release admission policy',
    );
  const contract = readJson(
    root,
    `node_modules/${packageName}/dist/site/buildchain-contract.json`,
  );
  if (
    contract.contractDigest !==
    (releaseRuntime.packageContractDigest || releaseRuntime.contractDigest)
  )
    throw new Error(
      'installed Buildchain contract digest differs from release admission policy',
    );
  const registry = readJson(root, registryPath);
  if (registry.registryDigest !== registryDigest)
    throw new Error(
      'installed Buildchain authority registry differs from release admission policy',
    );
  const descriptor = registry.entries?.find(
    (item) => item.workflowPath === policy.publication.workflowPath,
  );
  for (const [key, expected] of Object.entries(
    policy.buildchain.publicationAuthority,
  ))
    if (descriptor?.[key] !== expected)
      throw new Error(
        'Buildchain registry does not authorize the configured sealed publication lane',
      );
  return registry;
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

export function validatePrimitiveCatalogPromotion(catalog) {
  const issues = (catalog?.primitives || []).flatMap(verifyPrimitivePromotion);
  if (issues.length > 0) {
    throw new Error(`primitive promotion denied: ${issues.join(', ')}`);
  }
  return catalog;
}

function validatePrimitiveCatalogAdmission(root) {
  const source = fs.readFileSync(path.join(root, CATALOG_SOURCE), 'utf8');
  const artifact = fs.readFileSync(path.join(root, CATALOG_ARTIFACT), 'utf8');
  if (source !== artifact) {
    throw new Error(
      'release admission requires byte-identical primitive catalog projections',
    );
  }
  return validatePrimitiveCatalogPromotion(
    verifyPrimitiveCatalogIntegrity(JSON.parse(source)),
  );
}

export function validateKungfuReleaseAdmissionPolicy(root = ROOT) {
  const policy = readJson(root, POLICY);
  validatePolicy(root, policy);
  const primitiveCatalog = validatePrimitiveCatalogAdmission(root);
  const authority = validateWorkflowAuthority(root);
  if (authority.issues.length)
    throw new Error(
      `workflow authority is not closed: ${authority.issues.join('; ')}`,
    );
  validateAuthorityJob(authority.document, policy);
  return {
    policy,
    authority: authority.document,
    primitiveCatalog,
  };
}

export async function verifyKungfuReleaseAdmission({
  root = ROOT,
  admission,
  runnerProvenance,
  controlPlaneAudit,
  publicationEvidence,
  expected,
  usedNonces = [],
  now = new Date(),
  temporalAdmission,
  temporalVerifier = verifyTemporalReleaseAdmission,
} = {}) {
  const validated = validateKungfuReleaseAdmissionPolicy(root);
  const { policy, authority } = validated;
  const channel = admission?.channel;
  const buildchainRegistry = currentBuildchain(root, policy, channel);
  const buildchainPackage =
    channel === 'alpha'
      ? '@kungfu-tech/buildchain'
      : '@kungfu-tech/buildchain-stable';
  const { verifyPublicationAdmission } = await import(
    `${buildchainPackage}/publication-authority`
  );
  const aggregate = publicationEvidence?.gateAggregate;
  validateKungfuGateAggregate(root, aggregate, policy);
  const runtime = kungfuBuildchainRuntimePolicy(policy, channel);

  const fixedBindings = {
    repository: policy.repository,
    publisherWorkflowPath: policy.publication.publisherWorkflowPath,
    runtimeSha: runtime.publicationRuntimeSha,
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
  const temporalDigests =
    temporalAdmissionFactProjection(root, policy).channels[expected.channel] ||
    [];
  if (
    !temporalDigests
      .map((value) => normalizeDigest(value, 'temporal contract digest'))
      .includes(
        normalizeDigest(expected?.contractDigest, 'expected contract digest'),
      )
  )
    throw new Error(
      'Kungfu release admission expected contractDigest policy mismatch',
    );
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
  const consumerPolicyDigest = publicationAuthorityDigest(consumerPolicy);
  const temporalAdmissionReceipt = temporalVerifier({
    root,
    policy,
    runtime,
    expected,
    publicationEvidence,
    temporalAdmission,
    consumerPolicyDigest,
  });
  return {
    schema: 'kungfu.release-admission-capability/v1',
    qualifying: true,
    consumerPolicyDigest,
    temporalAdmissionReceipt,
    capability,
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function main() {
  const result = await verifyKungfuReleaseAdmission({
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
    temporalAdmission: readJson(
      ROOT,
      requiredFile(arg('temporal-admission'), 'temporal admission'),
    ),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
