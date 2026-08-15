#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH =
  'framework/data-protection/durable-history-qualification.contract.json';
const NODE_TESTS = [
  'scripts/check-durable-history-qualification.test.mjs',
  'scripts/check-data-protection-contract.test.mjs',
  'scripts/check-work-agent-history-continuity.test.mjs',
  'scripts/check-project-cut-dogfood-history.test.mjs',
  'scripts/check-product-release-cut-portability.test.mjs',
  'scripts/check-exit-history-surfaces.test.mjs',
];
const PYTHON_TESTS = [
  'framework/core/tests/python/test_exit_bundle.py::test_thin_package_is_honest_and_rejected_before_write',
  'framework/core/tests/python/test_exit_bundle.py::test_mid_import_fault_reports_landed_and_remaining_members',
  'framework/core/tests/python/test_exit_bundle.py::test_project_cut_history_member_survives_source_removal',
  'framework/core/tests/python/test_agent_work_profile_native.py::test_native_profile_authority_bundle_restores_clean_home_exactly',
  'framework/core/tests/python/test_agent_work_profile_native.py::test_native_profile_authority_import_preflights_all_operations_before_writing',
  'framework/core/tests/python/test_agent_work_profile_native.py::test_native_profile_backend_switch_and_rollback_preserve_five_role_identity',
  'framework/core/tests/python/test_agent_work_state_contract.py::test_kfd7_legacy_role_roots_remain_readable_without_reinterpretation',
  'framework/core/tests/python/test_product_release_history.py',
  'framework/core/tests/python/test_work_control_profile.py::test_native_initiative_bundle_roundtrip',
  'framework/core/tests/python/test_episode_manifest_fsck.py::test_consistent_seal_passes_fsck',
];

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function digestDocument(value) {
  return digestBytes(Buffer.from(JSON.stringify(canonical(value))));
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function fileEvidence(relative) {
  return {
    path: relative,
    root: digestBytes(fs.readFileSync(path.join(ROOT, relative))),
  };
}

function findNativeArtifact() {
  const directory = path.join(ROOT, 'framework/core/build/Release');
  const name = fs
    .readdirSync(directory)
    .find((candidate) => /^pykungfu.*\.(?:so|pyd)$/u.test(candidate));
  if (!name)
    throw new Error(
      'native pykungfu artifact is absent; run ./shifu build:core',
    );
  const absolute = path.join(directory, name);
  return {
    path: path.relative(ROOT, absolute).split(path.sep).join('/'),
    root: digestBytes(fs.readFileSync(absolute)),
  };
}

export function buildReceipt({
  contract,
  corpus,
  sourceRevision,
  sourceFiles,
  nativeArtifact,
  executions = [],
  platform = os.platform(),
  architecture = os.arch(),
  qualifiedAt = new Date().toISOString(),
}) {
  const campaignResults = corpus.campaigns.map(({ id, proof }) => ({
    id,
    proof,
    status: 'passed',
  }));
  const review = {
    status: 'required-before-terminal-close',
    criteria: contract.independentReview.mustVerify,
  };
  const sourceRoot = (relative) =>
    sourceFiles.find(({ path: candidate }) => candidate === relative)?.root;
  const assessment = {
    status: 'passed',
    campaignResults,
    executions,
  };
  const receipt = {
    schema: contract.receipt.schema,
    status: contract.boundedClaim.status,
    qualifiedAt,
    environment: { platform, architecture, homePolicy: 'disposable-only' },
    source: {
      revision: sourceRevision,
      files: sourceFiles,
      sourceSetRoot: digestDocument(sourceFiles),
    },
    artifact: nativeArtifact,
    bindings: {
      schemaRoot: digestDocument({
        qualification: contract.schema,
        receipt: contract.receipt.schema,
        campaignCorpus: corpus.schema,
      }),
      interpreterRoot: digestDocument({
        node: process.version,
        nativeArtifactRoot: nativeArtifact.root,
      }),
      contractRoot: digestDocument(contract),
      entrypointMatrixRoot: digestDocument(contract.entrypointMatrix),
      bundleContractRoot: sourceRoot(
        'framework/exit/kungfu-exit-bundle.contract.json',
      ),
      migrationContractRoot: sourceRoot(
        'framework/upgrade/kungfu-product-release-cut.contract.json',
      ),
      campaignCorpusRoot: digestDocument(corpus),
      campaignResultRoot: digestDocument(campaignResults),
      executionRoot: digestDocument(executions),
      assessmentRoot: digestDocument(assessment),
      boundedClaimRoot: digestDocument(contract.boundedClaim),
      reviewRoot: digestDocument(review),
    },
    campaigns: campaignResults,
    executions,
    assessment,
    claim: contract.boundedClaim,
    deferred: contract.deferred,
    privacyExclusions: contract.receipt.privacyExclusions,
    review,
  };
  receipt.receiptRoot = digestDocument(receipt);
  return receipt;
}

function runQualification() {
  const pythonPath = [
    path.join(ROOT, 'framework/core/src/python'),
    path.join(ROOT, 'framework/core/build/Release'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const commands = [
    {
      id: 'cross-domain-node-contracts',
      executable: process.execPath,
      displayExecutable: 'node',
      args: ['--test', ...NODE_TESTS],
      env: process.env,
    },
    {
      id: 'disposable-native-campaigns',
      executable: 'uv',
      displayExecutable: 'uv',
      args: [
        'run',
        '--project',
        'framework/core',
        '--frozen',
        'pytest',
        '-q',
        ...PYTHON_TESTS,
      ],
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        KUNGFU_NATIVE_PATH: path.join(ROOT, 'framework/core/build/Release'),
      },
    },
  ];
  return commands.map(({ id, executable, displayExecutable, args, env }) => {
    const result = spawnSync(executable, args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error || result.status !== 0) {
      process.stderr.write(output);
      throw (
        result.error ||
        new Error(`${id} exited ${result.status ?? 'without-status'}`)
      );
    }
    return {
      id,
      command: [displayExecutable, ...args].join(' '),
      exitCode: result.status,
      outputRoot: digestBytes(Buffer.from(output)),
    };
  });
}

function main() {
  if (!process.argv.includes('--json'))
    throw new Error('only --json machine output is supported');
  const contract = readJson(CONTRACT_PATH);
  const corpus = readJson(contract.campaigns.corpus);
  const executions = runQualification();
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (revision.error || revision.status !== 0)
    throw revision.error || new Error('git rev-parse HEAD failed');
  const receipt = buildReceipt({
    contract,
    corpus,
    sourceRevision: revision.stdout.trim(),
    sourceFiles: contract.receipt.sourceClosure.map(fileEvidence),
    nativeArtifact: findNativeArtifact(),
    executions,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[durable-history-qualification] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
