// SPDX-License-Identifier: Apache-2.0

import process from 'node:process';

import { createPowerCutPlan } from '@kungfu-tech/core/testing/qualification/durability/powercut_plan';

function options(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`expected --key value, received '${key || ''}'`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const parsed = options(args);
  const plan = createPowerCutPlan({
    runId: parsed['run-id'],
    repo: parsed.repo,
    sourceRevision: parsed['source-revision'],
    image: parsed.image,
    kernelRelease: parsed['kernel-release'],
    kernelVersion: parsed['kernel-version'],
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} catch (error) {
  console.error(
    `[durability-powercut-plan] ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    'usage: ./shifu durability:powercut:plan -- --run-id ID --repo /data/worktrees/kungfu/feature/NAME --source-revision SHA --image IMAGE --kernel-release RELEASE --kernel-version VERSION',
  );
  process.exit(64);
}
