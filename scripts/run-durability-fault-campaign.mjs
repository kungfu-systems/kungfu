// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFaultCampaignMatrix } from '@kungfu-tech/core/testing/qualification/durability/fault_campaign';
import {
  command,
  executeTrial,
  parseOptions,
  requireBelow,
  sha256,
} from './run-durability-powercut-qemu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = '/data/qualification/kungfu/durability';
const CONFIRMATION = 'disposable-powercut-v2';
const WORKSPACE_SENTINEL = 'kungfu.durability.qemu-workspace/v1\n';

function requireFileContent(pathname, expected, label) {
  if (fs.readFileSync(pathname, 'utf8') !== expected) {
    throw new Error(`${label} sentinel is absent or invalid`);
  }
}

function compactResult(result) {
  return {
    id: result.id,
    matrix_trial_id: result.matrix_trial_id,
    status: result.status,
    profile: result.profile,
    fault: result.fault,
    cycle: result.cycle,
    seed: result.seed,
    envelope: result.envelope,
    data_format: result.data_format,
    cache_mode: result.cache_mode,
    aio_mode: result.aio_mode,
    started_at: result.started_at,
    finished_at: result.finished_at,
    elapsed_ms: result.elapsed_ms,
    expected_durable_sequence: result.expected_durable_sequence,
    verification: result.verification,
    evidence: result.evidence,
    error: result.error,
  };
}

function appendRaw(fd, result) {
  fs.writeSync(fd, `${JSON.stringify(result)}\n`);
  fs.fsyncSync(fd);
}

export function createFaultCampaignPlan({
  workspace,
  rootfsBase,
  report,
  rawResults,
  sourceRevision,
  kernelRelease,
  canaryTrial = null,
  execute = false,
}) {
  const matrix = createFaultCampaignMatrix();
  const selectedTrial = canaryTrial
    ? matrix.trials.find((trial) => trial.id === canaryTrial)
    : null;
  if (canaryTrial && !selectedTrial) {
    throw new Error(`unknown canary trial: ${canaryTrial}`);
  }
  return {
    schema: 'kungfu.durability.fault-campaign-execution-plan/v2',
    mode: execute ? 'execute' : 'dry-run',
    source_revision: sourceRevision,
    workspace,
    rootfs_base: rootfsBase,
    report,
    raw_results: rawResults,
    kernel_release: kernelRelease,
    execution_kind: canaryTrial ? 'non-qualifying-canary' : 'full-campaign',
    matrix: {
      schema: matrix.schema,
      profile_id: matrix.profile.id,
      profile_digest: matrix.profile_digest,
      trial_count: matrix.trial_count,
      required_cycles: matrix.profile.required_cycles,
      seeds: matrix.profile.seeds,
      device_envelopes: matrix.profile.device_envelopes,
      faults: matrix.profile.faults.map((fault) => fault.name),
      durability_profiles: matrix.profile.durability_profiles,
      selected_trials: canaryTrial
        ? [canaryTrial]
        : matrix.trials.map((trial) => trial.id),
    },
    safety: {
      creates_only_below: workspace,
      refuses_existing_report_or_raw_results: true,
      records_each_trial_before_continuing: true,
      failed_campaign_workspace_is_not_reused: true,
      direct_child_qemu_only: true,
      github_workflow: false,
      physical_device_write: false,
      physical_host_restart: false,
      cleanup: 'not performed; preserve the complete workspace for review',
      canary_is_never_qualification_evidence: true,
    },
  };
}

async function main() {
  const parsed = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== '--'),
  );
  const workspace = requireBelow(parsed.workspace, WORKSPACE_ROOT, 'workspace');
  const rootfsBase = requireBelow(
    parsed['rootfs-base'],
    workspace,
    'rootfs base',
  );
  const report = requireBelow(parsed.report, workspace, 'report');
  const rawResults = requireBelow(
    parsed['raw-results'],
    workspace,
    'raw results',
  );
  const sourceRevision = command(['git', 'rev-parse', 'HEAD']);
  const kernelRelease = parsed['kernel-release'];
  const canaryTrial = parsed['canary-trial'] || null;
  if (
    !kernelRelease ||
    !/^[0-9][0-9A-Za-z.+~-]*-generic$/u.test(kernelRelease)
  ) {
    throw new Error('safe --kernel-release is required');
  }
  const plan = createFaultCampaignPlan({
    workspace,
    rootfsBase,
    report,
    rawResults,
    sourceRevision,
    kernelRelease,
    canaryTrial,
    execute: parsed.execute,
  });
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('fault campaign execution requires Linux x64');
  }
  if (process.env.KUNGFU_DURABILITY_QEMU_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `KUNGFU_DURABILITY_QEMU_CONFIRMATION=${CONFIRMATION} is required`,
    );
  }
  requireFileContent(
    `${workspace}/.kungfu-disposable-qemu-workspace`,
    WORKSPACE_SENTINEL,
    'workspace',
  );
  if (!fs.existsSync(rootfsBase)) {
    throw new Error(`rootfs base missing: ${rootfsBase}`);
  }
  if (!fs.existsSync(`${workspace}/data-base.ext4`)) {
    throw new Error('data base missing');
  }
  if (!fs.existsSync(`${workspace}/kernel/boot/vmlinuz-${kernelRelease}`)) {
    throw new Error('campaign kernel image missing');
  }
  for (const pathname of [report, rawResults]) {
    if (fs.existsSync(pathname)) {
      throw new Error(`refusing existing campaign evidence: ${pathname}`);
    }
  }
  if (
    canaryTrial &&
    [report, rawResults].some(
      (pathname) => !path.basename(pathname).includes('canary'),
    )
  ) {
    throw new Error(
      'canary report and raw-results filenames must include canary',
    );
  }
  if (command(['git', 'status', '--porcelain']) !== '') {
    throw new Error('source worktree must be clean');
  }
  const matrix = createFaultCampaignMatrix();
  const selectedTrials = canaryTrial
    ? matrix.trials
        .filter((trial) => trial.id === canaryTrial)
        .map((trial) => ({
          ...trial,
          matrix_trial_id: trial.id,
          id: `canary-${trial.id}`,
        }))
    : matrix.trials;
  const rawFd = fs.openSync(rawResults, 'wx');
  const campaignStarted = new Date();
  const results = [];
  try {
    for (const trial of selectedTrials) {
      const started = new Date();
      let result;
      try {
        const passed = await executeTrial({
          trial: { ...trial, kernel_release: kernelRelease },
          workspace,
          rootfsBase,
        });
        result = {
          ...passed,
          matrix_trial_id: trial.matrix_trial_id || trial.id,
          cycle: trial.cycle,
          envelope: trial.envelope,
          started_at: started.toISOString(),
          finished_at: new Date().toISOString(),
          elapsed_ms: Date.now() - started.getTime(),
          error: null,
        };
      } catch (error) {
        result = {
          id: trial.id,
          matrix_trial_id: trial.matrix_trial_id || trial.id,
          status: 'failed',
          profile: trial.profile,
          fault: trial.fault,
          cycle: trial.cycle,
          seed: trial.seed,
          envelope: trial.envelope,
          data_format: trial.data_format,
          cache_mode: trial.cache_mode,
          aio_mode: trial.aio_mode,
          expected_durable_sequence: trial.expected_durable_sequence,
          started_at: started.toISOString(),
          finished_at: new Date().toISOString(),
          elapsed_ms: Date.now() - started.getTime(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      appendRaw(rawFd, result);
      results.push(result);
      console.log(
        `[durability-fault-campaign] ${result.status} ${result.id} (${results.length}/${selectedTrials.length})`,
      );
    }
  } finally {
    fs.closeSync(rawFd);
  }
  const campaignFinished = new Date();
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  const complete = !canaryTrial && results.length === matrix.trial_count;
  const qualified = complete && failed === 0;
  const canaryPassed =
    Boolean(canaryTrial) && results.length === 1 && failed === 0;
  const output = {
    schema: 'kungfu.durability.fault-campaign-report/v2',
    verdict: canaryTrial
      ? canaryPassed
        ? 'canary-passed'
        : 'canary-failed'
      : qualified
        ? 'passed'
        : 'failed',
    source: {
      revision: sourceRevision,
      tree: command(['git', 'rev-parse', 'HEAD^{tree}']),
      dirty: false,
    },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      qemu: command(['qemu-system-x86_64', '--version']).split('\n')[0],
      workspace_filesystem: command(['stat', '-f', '-c', '%T', workspace]),
    },
    execution: plan,
    timing: {
      started_at: campaignStarted.toISOString(),
      finished_at: campaignFinished.toISOString(),
      elapsed_ms: campaignFinished.getTime() - campaignStarted.getTime(),
    },
    integrity: {
      raw_results: path.relative(workspace, rawResults),
      raw_results_sha256: await sha256(rawResults),
      raw_result_count: results.length,
      matrix_profile_digest: matrix.profile_digest,
    },
    counts: {
      required: matrix.trial_count,
      executed: results.length,
      passed,
      failed,
    },
    claims: {
      complete_required_matrix: complete,
      disposable_vm_device_model_campaign_qualified: qualified,
      repeated_seed_cycles_qualified: qualified,
      fresh_verification_boot_per_trial_qualified: qualified,
      physical_power_loss_qualified: false,
      physical_device_cache_qualified: false,
      production_profile_eligible: false,
      canary_only: Boolean(canaryTrial),
    },
    results: results.map(compactResult),
  };
  fs.writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(`[durability-fault-campaign] report=${report}`);
  if (canaryTrial ? !canaryPassed : !qualified) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[durability-fault-campaign] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  }
}
