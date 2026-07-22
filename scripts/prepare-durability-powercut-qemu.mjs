// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createPowerCutPlan } from '../framework/core/tests/qualification/durability/powercut_plan.mjs';
import { command, parseOptions } from './run-durability-powercut-qemu.mjs';

const CONFIRMATION = 'disposable-powercut-prepare-v1';

function runStep(step) {
  const result = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: step.cwd || undefined,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `prepare step ${step.id} failed: ${result.error?.message || result.status}`,
    );
  }
}

export function preparationView(plan, execute = false) {
  return {
    schema: 'kungfu.durability.powercut-prepare-plan/v1',
    mode: execute ? 'execute' : 'dry-run',
    source_revision: plan.target.source_revision,
    target: plan.target,
    safety: {
      ...plan.safety,
      removes_only_new_run_scoped_container: plan.safety.disposable_container,
      cleanup: 'not performed; preserve workspace and evidence for review',
    },
    steps: plan.prepare,
  };
}

async function main() {
  const parsed = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== '--'),
  );
  const sourceRevision = command(['git', 'rev-parse', 'HEAD']);
  const plan = createPowerCutPlan({
    runId: parsed['run-id'],
    repo: parsed.repo,
    sourceRevision,
    image: parsed.image,
    kernelRelease: parsed['kernel-release'],
    kernelVersion: parsed['kernel-version'],
  });
  const view = preparationView(plan, parsed.execute);
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('QEMU preparation requires Linux x64');
  }
  if (fs.realpathSync(parsed.repo) !== fs.realpathSync(process.cwd())) {
    throw new Error('execute must run from the exact --repo worktree');
  }
  if (process.env.KUNGFU_DURABILITY_PREPARE_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `KUNGFU_DURABILITY_PREPARE_CONFIRMATION=${CONFIRMATION} is required`,
    );
  }
  if (command(['git', 'status', '--porcelain']) !== '') {
    throw new Error('source worktree must be clean');
  }
  if (command(['git', 'rev-parse', 'HEAD']) !== plan.target.source_revision) {
    throw new Error('source revision changed after planning');
  }
  if (fs.existsSync(plan.target.workspace)) {
    throw new Error(`refusing existing workspace: ${plan.target.workspace}`);
  }
  for (const step of plan.prepare) {
    console.log(
      `[durability-powercut-prepare] ${step.mutates ? 'mutate' : 'check'} ${step.id}`,
    );
    runStep(step);
  }
  console.log(
    `[durability-powercut-prepare] workspace=${plan.target.workspace}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[durability-powercut-prepare] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  }
}
