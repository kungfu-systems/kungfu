#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildGatePlan,
  gateActionId,
  gateDefinitionDigest,
  gateDigest,
} from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = 'docs/qualification/gates/release-admission-policy.json';
const RUNTIME_MODULE =
  '.buildchain/qualification-runtime/packages/core/publication-authority.js';

export const KUNGFU_PUBLICATION_PREDICATE_ID = 'kungfu.release-admission/v1';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeDigest(value, label) {
  const digest = String(value || '')
    .replace(/^sha256:/, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function exact(value, expected, label) {
  if (String(value || '') !== String(expected || ''))
    throw new Error(`${label} policy mismatch`);
}

function validatePolicy(policy) {
  if (policy?.schema !== 'kungfu.release-admission-policy/v1')
    throw new Error('unsupported Kungfu release admission policy');
  if (
    !Array.isArray(policy.requiredPlatforms) ||
    policy.requiredPlatforms.join('\0') !==
      'linux-x64\0linux-arm64\0macos-arm64\0windows-x64'
  )
    throw new Error(
      'Kungfu release admission requires linux-x64, linux-arm64, macos-arm64, and windows-x64',
    );
  if (
    !Array.isArray(policy.publication?.channels) ||
    policy.publication.channels.length === 0
  )
    throw new Error('Kungfu publication channels are not configured');
  for (const channel of policy.publication.channels)
    kungfuBuildchainRuntimePolicy(policy, channel);
}

export function kungfuBuildchainRuntimePolicy(policy, channel) {
  const runtime = policy?.buildchain?.runtimes?.[channel];
  if (!runtime)
    throw new Error(`Kungfu Buildchain runtime is not pinned for ${channel}`);
  if (!/^[0-9a-f]{40}$/.test(String(runtime.runtimeSha || '')))
    throw new Error(`Kungfu Buildchain runtime SHA is invalid for ${channel}`);
  if (!/^[0-9a-f]{40}$/.test(String(runtime.publicationRuntimeSha || '')))
    throw new Error(
      `Kungfu Buildchain publication runtime SHA is invalid for ${channel}`,
    );
  normalizeDigest(runtime.contractDigest, `${channel} contract digest`);
  const projection = runtime.contractProjection;
  if (
    projection?.schema !==
      'kungfu.temporal-release-admission-digest-projection/v1' ||
    projection?.authority !== 'non-authoritative' ||
    !Array.isArray(projection?.entries) ||
    projection.entries.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(projection?.sourceFactSetRoot || ''),
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(projection?.projectionRoot || ''))
  )
    throw new Error(
      `Kungfu Buildchain contract projection is invalid for ${channel}`,
    );
  if (!runtime.ref || !runtime.contractLock)
    throw new Error(
      `Kungfu Buildchain runtime metadata is incomplete for ${channel}`,
    );
  return runtime;
}

function verifyContractFactSelection(root, policy, runtime, capability) {
  const request = {
    contract: readJson(path.resolve(root, policy.temporalAdmission.contract)),
    admissionFacts: readJson(
      path.resolve(root, policy.temporalAdmission.admissionFacts),
    ),
    compatibilityFacts: readJson(
      path.resolve(root, policy.temporalAdmission.compatibilityFacts),
    ),
    currentContractLock: readJson(path.resolve(root, runtime.contractLock)),
    channel: capability?.channel,
    acceptedContractDigest: `sha256:${normalizeDigest(
      capability?.contractDigest,
      'capability.contractDigest',
    )}`,
    currentContractDigest: runtime.contractDigest,
  };
  const pythonPath = path.join(root, 'framework/core/src/python');
  const result = childProcess.spawnSync(
    process.env.PYTHON || 'python3',
    [path.join(root, 'scripts/release-provenance-object.py'), 'fact-selection'],
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
      `contract Fact selection returned invalid JSON: ${String(result.stderr || '').trim()}`,
    );
  }
  if (result.status !== 0 || report.ok !== true)
    throw new Error(
      `Buildchain contract Fact selection rejected: ${report.receipt?.reasonCodes?.join(', ') || 'unknown'}`,
    );
  if (
    report.receipt?.schema !==
      'kungfu.temporal-release-admission-fact-selection-receipt/v1' ||
    report.receipt?.status !== 'accepted' ||
    report.receipt?.containsPrivatePayload !== false
  )
    throw new Error(
      'Buildchain contract Fact selection receipt is not qualifying',
    );
  return report.receipt;
}

export function validateKungfuGateAggregate(root, aggregate, policy) {
  if (aggregate?.contract !== 'buildchain.shifu-gate-aggregate/v1')
    throw new Error('Kungfu requires a Buildchain Shifu Gate aggregate');
  if (
    aggregate.profile !== policy.profile ||
    aggregate.status !== 'pass' ||
    aggregate.ok !== true ||
    aggregate.qualifying !== true
  )
    throw new Error(
      'Kungfu release Gate aggregate is not qualifying for the configured profile',
    );
  if (!Array.isArray(aggregate.issues) || aggregate.issues.length !== 0)
    throw new Error('Kungfu release Gate aggregate contains issues');

  const registry = readJson(path.resolve(root, 'shifu.gates.json'));
  const registryDigest = gateDigest(registry);
  exact(aggregate.registry?.digest, registryDigest, 'Gate registry digest');
  const plan = buildGatePlan(registry, policy.profile, {
    digest: registryDigest,
  });
  if (!plan.ok || !plan.qualifying)
    throw new Error('current Kungfu release Gate plan is not qualifying');

  const expectedGates = new Map(
    plan.groups.flatMap((group) => group.gates).map((gate) => [gate.id, gate]),
  );
  const definitions = new Map(registry.gates.map((gate) => [gate.id, gate]));
  const covered = new Set();
  for (const row of aggregate.gates || []) {
    const gate = expectedGates.get(row.gateId);
    const definition = definitions.get(row.gateId);
    if (!gate || !definition)
      throw new Error(`Gate aggregate contains unknown Gate '${row.gateId}'`);
    if (
      row.mode !== gate.mode ||
      row.definitionDigest !== gateDefinitionDigest(definition) ||
      row.actionId !== gateActionId(definition)
    )
      throw new Error(`Gate aggregate definition drift for '${row.gateId}'`);
    if (
      row.attempted !== true ||
      !['pass', 'passed', 'success'].includes(row.status) ||
      (Array.isArray(row.issues) && row.issues.length)
    )
      throw new Error(`Gate aggregate row did not qualify for '${row.gateId}'`);
    covered.add(row.gateId);
  }

  const missing = [...expectedGates.keys()].filter(
    (gateId) => !covered.has(gateId),
  );
  if (missing.length)
    throw new Error(
      `Gate aggregate is missing required Gates: ${missing.join(', ')}`,
    );
  if (
    !Array.isArray(aggregate.receipts) ||
    aggregate.receipts.length === 0 ||
    aggregate.receipts.some(
      (receipt) =>
        receipt.qualifying !== true ||
        !['pass', 'passed', 'success'].includes(receipt.status) ||
        (Array.isArray(receipt.issues) && receipt.issues.length),
    )
  )
    throw new Error(
      'Gate aggregate has missing or non-qualifying platform receipts',
    );

  const receiptPlatforms = new Set(
    aggregate.receipts.map((receipt) =>
      String(
        receipt.platform?.id ||
          receipt.platformId ||
          receipt.platform?.os ||
          receipt.platform ||
          '',
      ).toLowerCase(),
    ),
  );
  for (const platform of policy.requiredPlatforms)
    if (!receiptPlatforms.has(platform))
      throw new Error(`Gate aggregate is missing ${platform} qualification`);

  return { registryDigest, plan };
}

export async function createKungfuConsumerPublicationDecision({
  root = ROOT,
  capability,
  gateAggregate,
  predicateId,
  predicateDigest,
  createDecision,
  now = new Date(),
} = {}) {
  const policy = readJson(path.resolve(root, POLICY));
  validatePolicy(policy);
  const runtime = kungfuBuildchainRuntimePolicy(policy, capability?.channel);
  const { registryDigest, plan } = validateKungfuGateAggregate(
    root,
    gateAggregate,
    policy,
  );

  exact(capability?.repository, policy.repository, 'repository');
  exact(
    capability?.workflowPath,
    policy.publication.workflowPath,
    'authority workflow',
  );
  exact(
    capability?.publisherWorkflowPath,
    policy.publication.publisherWorkflowPath,
    'publisher workflow',
  );
  exact(capability?.environment, policy.publication.environment, 'environment');
  exact(capability?.product, policy.publication.product, 'product');
  exact(capability?.target, policy.publication.target, 'target');
  exact(capability?.runtimeSha, runtime.publicationRuntimeSha, 'runtime SHA');
  if (!policy.publication.channels.includes(capability?.channel))
    throw new Error('Kungfu release admission channel is not allowed');
  exact(capability?.sourceSha, gateAggregate.sourceSha, 'Gate source SHA');
  if (
    normalizeDigest(
      capability?.gateRegistryDigest,
      'capability.gateRegistryDigest',
    ) !== normalizeDigest(registryDigest, 'Gate registry digest')
  )
    throw new Error('Kungfu Gate registry binding mismatch');
  if (
    normalizeDigest(capability?.policyDigest, 'capability.policyDigest') !==
    normalizeDigest(gateAggregate.matrixDigest, 'Gate matrix digest')
  )
    throw new Error('Kungfu Gate policy binding mismatch');
  exact(predicateId, KUNGFU_PUBLICATION_PREDICATE_ID, 'predicate id');
  if (typeof createDecision !== 'function')
    throw new Error('Buildchain consumer decision factory is required');
  const contractFactSelection = verifyContractFactSelection(
    root,
    policy,
    runtime,
    capability,
  );

  return createDecision({
    capability,
    gateAggregate,
    decision: 'allow',
    predicateId,
    predicateDigest,
    now,
    evidence: {
      schema: 'kungfu.release-admission-consumer-evidence/v1',
      profile: policy.profile,
      requiredPlatforms: [...policy.requiredPlatforms],
      gateRegistryDigest: registryDigest,
      gateMatrixDigest: gateAggregate.matrixDigest,
      gateCount: plan.groups.flatMap((group) => group.gates).length,
      receiptCount: gateAggregate.receipts.length,
      contractFactSelection,
    },
  });
}

async function main() {
  const capabilityPath = process.env.BUILDCHAIN_PUBLICATION_CAPABILITY_PATH;
  const aggregatePath = process.env.BUILDCHAIN_PUBLICATION_GATE_AGGREGATE_PATH;
  const resultPath =
    process.env.BUILDCHAIN_PUBLICATION_QUALIFICATION_RESULT_PATH;
  if (!capabilityPath || !aggregatePath || !resultPath)
    throw new Error('Buildchain publication qualification paths are required');

  const runtimeModule = path.resolve(ROOT, RUNTIME_MODULE);
  const { createConsumerPublicationDecision } = await import(
    pathToFileURL(runtimeModule).href
  );
  const decision = await createKungfuConsumerPublicationDecision({
    capability: readJson(path.resolve(ROOT, capabilityPath)),
    gateAggregate: readJson(path.resolve(ROOT, aggregatePath)),
    predicateId: process.env.BUILDCHAIN_PUBLICATION_PREDICATE_ID,
    predicateDigest: process.env.BUILDCHAIN_PUBLICATION_PREDICATE_DIGEST,
    createDecision: createConsumerPublicationDecision,
  });
  fs.mkdirSync(path.dirname(path.resolve(ROOT, resultPath)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.resolve(ROOT, resultPath),
    `${JSON.stringify(decision, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[kungfu-release-qualification] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
