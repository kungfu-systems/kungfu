// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { openProfile } from '../../../framework/api/src/capability/profile.ts';

const repo = process.cwd();
const runtimeRoot = process.env.KUNGFU_QUALIFICATION_RUNTIME_ROOT || repo;
const core = path.join(runtimeRoot, 'framework', 'core');
const python = path.join(core, '.venv', 'bin', 'python');
const release = path.join(core, 'build', 'Release');
const pythonPath = [
  path.join(repo, 'framework', 'core', 'src', 'python'),
  release,
].join(path.delimiter);
const runtimeEnv = {
  ...process.env,
  KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
  PYTHONPATH: pythonPath,
};

const setupText = execFileSync(
  python,
  [path.join(repo, 'tests', 'qualification', 'profile-kfd3', 'setup.py'), repo],
  {
    encoding: 'utf8',
    env: runtimeEnv,
  },
);
const context = JSON.parse(setupText) as {
  source: string;
  runtime: string;
  profileId: string;
  profileSuiteRoot: string;
  intentId: string;
};
type QualificationReceipt = {
  profileSuiteRoot: string;
  receiptId: string;
  witness: { witnessId: string };
  clientProbes: Array<{
    humanPlanId: string;
    agentPlanId: string;
  }>;
};
const env = { ...runtimeEnv, KF_RUNTIME_DIR: context.runtime };
const agentReceipt = JSON.parse(
  execFileSync(
    python,
    ['-m', 'kungfu', 'profile', 'kfd3-qualify', context.source, '--json'],
    {
      encoding: 'utf8',
      env,
    },
  ),
) as QualificationReceipt;

const execSync = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
): string =>
  execFileSync(
    file,
    file === python ? ['-m', 'kungfu', ...args] : args,
    options,
  );
const human = openProfile({
  runtimeDir: context.runtime,
  bin: python,
  env,
  execFileSync: execSync,
});
const humanReceipt = human.qualifyKfd3(context.source);
const application = human.application(context.source);
const humanPlan = human.intentPlan(context.source, context.intentId);

assert.equal(context.profileId, 'example.week-day');
assert.equal(agentReceipt.profileSuiteRoot, context.profileSuiteRoot);
assert.equal(humanReceipt.receiptId, agentReceipt.receiptId);
assert.equal(humanReceipt.witness.witnessId, agentReceipt.witness.witnessId);
assert.equal(application.qualified, true);
assert.equal(
  application.qualification.witnessId,
  agentReceipt.witness.witnessId,
);
assert.equal(humanPlan.planId, agentReceipt.clientProbes[0].humanPlanId);
assert.equal(
  agentReceipt.clientProbes[0].humanPlanId,
  agentReceipt.clientProbes[0].agentPlanId,
);

console.log(
  JSON.stringify({
    schema: 'kungfu.profile-kfd3-dual-client-proof/v1',
    domain: 'week-day',
    profileId: context.profileId,
    profileSuiteRoot: context.profileSuiteRoot,
    receiptId: agentReceipt.receiptId,
    witnessId: agentReceipt.witness.witnessId,
    planId: humanPlan.planId,
    clients: ['agent-cli', 'typed-human-api'],
    verified: true,
  }),
);
