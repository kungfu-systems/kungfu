// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const workflowText = fs.readFileSync('.github/workflows/build.yml', 'utf8');
const workflow = parse(workflowText);
const scenario = JSON.parse(
  fs.readFileSync('.buildchain/auditable-demo.json', 'utf8'),
);
const demo = workflow.jobs['auditable-demo'];
const build = workflow.jobs.build;

test('one exact Buildchain workflow owns every declared demo', () => {
  assert.match(
    demo.uses,
    /^kungfu-systems\/buildchain\/\.github\/workflows\/\.declarative-auditable-demo\.yml@[0-9a-f]{40}$/u,
  );
  assert.deepEqual(
    scenario.demos.map(({ id, steps }) => ({ id, argv: steps[0].argv })),
    [
      {
        id: 'agent-work-lab-autoplay',
        argv: ['agent-work-lab', 'autoplay'],
      },
      {
        id: 'project-tour-08x',
        argv: ['agent-work-lab', 'project-tour', '--speed', '0.8'],
      },
    ],
  );
  assert.equal(scenario.execution.durationClass, 'long-form');
  assert.equal(scenario.execution.totalTimeoutSeconds, 180);
  assert.deepEqual(scenario.transportSmoke, {
    argv: ['agent-work-lab', 'autoplay'],
    timeoutSeconds: 60,
    expectedExitCodes: [0],
    stdoutIncludes: ['KUNGFU_TUI_DEMO_COMPLETE'],
  });
  assert.equal(
    demo.with['media-profile'],
    'responsive-long-form-web-delivery-v1',
  );
});

test('the build fails the real transported binary before either upload path', () => {
  assert.equal(
    build.uses,
    'kungfu-systems/buildchain/.github/workflows/.build.yml@5246afd4ff5608f6e8d09fb71003992119364880',
  );
  assert.equal(
    demo.uses,
    'kungfu-systems/buildchain/.github/workflows/.declarative-auditable-demo.yml@5246afd4ff5608f6e8d09fb71003992119364880',
  );
  assert.equal(
    build.with['pre-upload-transport-smoke-scenario-path'],
    '.buildchain/auditable-demo.json',
  );
  assert.equal(build.with['pre-upload-transport-smoke-artifact-root'], '.');
});

test('manual full refresh and promotion reuse the same materializer', () => {
  const sharedIntent =
    "${{ github.event_name != 'workflow_dispatch' || inputs.render-auditable-demo }}";
  assert.equal(demo.with['render-media'], sharedIntent);
  assert.equal(demo.with.materialize, sharedIntent);
  assert.equal(
    demo.with['materialize-base-ref'],
    '${{ github.event.repository.default_branch }}',
  );
  assert.equal(
    demo.secrets.DEMO_UPDATE_TOKEN,
    '${{ secrets.KUNGFU_GITHUB_TOKEN }}',
  );
});

test('the exact same-run artifact contains the standalone demo distribution', () => {
  assert.match(
    workflowText,
    /artifact-paths:[\s\S]*product\/release[\s\S]*product\/dist\/cli\/kungfu-episodes-cli-linux-x64/u,
  );
  assert.equal(
    scenario.artifact.binaryPath,
    'product/dist/cli/kungfu-episodes-cli-linux-x64/kungfu',
  );
  assert.equal(
    scenario.artifact.metadataContract,
    'kungfu.declarative-demo-binary/v1',
  );
  assert.deepEqual(scenario.artifact.runtimeDependencies, []);
  assert.match(
    demo.with['renderer-image'],
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u,
  );
});

test('legacy product-specific demo authorities are absent', () => {
  for (const job of ['auditable-demo-plan', 'auditable-demo-passport']) {
    assert.equal(workflow.jobs[job], undefined);
  }
  assert.doesNotMatch(
    workflowText,
    /\.auditable-demo\.yml|auditable-demo-adapter|auditable-demo-passport|update-auditable-demo-readme/u,
  );
  assert.deepEqual(scenario.authority.grants, []);
});

test('legacy product-specific entrypoints are fail-closed tombstones', () => {
  for (const [runtime, script] of [
    [process.execPath, 'scripts/auditable-demo-passport.mjs'],
    [process.execPath, 'scripts/update-auditable-demo-readme.mjs'],
    ['python3', 'scripts/auditable-demo-adapter.py'],
  ]) {
    const result = spawnSync(runtime, [script], { encoding: 'utf8' });
    assert.equal(result.status, 1, script);
    assert.match(result.stderr, /retired/u, script);
  }
});
