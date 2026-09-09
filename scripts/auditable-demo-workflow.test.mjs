// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const workflowText = fs.readFileSync(
  '.github/workflows/auditable-demo.yml',
  'utf8',
);
const workflow = parse(workflowText);
const releaseBuildText = fs.readFileSync('.github/workflows/build.yml', 'utf8');
const releaseBuild = parse(releaseBuildText);
const scenario = JSON.parse(
  fs.readFileSync('.buildchain/auditable-demo.json', 'utf8'),
);
const transportScenario = JSON.parse(
  fs.readFileSync('.buildchain/auditable-demo-transport-smoke.json', 'utf8'),
);
const demo = workflow.jobs['auditable-demo'];
const build = workflow.jobs.build;
const readme = fs.readFileSync('README.md', 'utf8');
const technicalSpec = fs.readFileSync(
  'docs/qualification/auditable-demo-artifact-pipeline.md',
  'utf8',
);

test('one governed Buildchain v4 workflow owns every declared demo', () => {
  assert.match(
    demo.uses,
    /^kungfu-systems\/buildchain\/\.github\/workflows\/public-build-demo\.yml@v4-alpha$/u,
  );
  assert.deepEqual(
    scenario.demos.map(({ id, steps }) => ({ id, argv: steps[0].argv })),
    [
      {
        id: 'agent-work-lab-autoplay',
        argv: ['agent-work-lab', 'autoplay'],
      },
      {
        id: 'project-tour-episode-1',
        argv: [
          'agent-work-lab',
          'project-tour',
          '--episode',
          '1',
          '--speed',
          '4',
        ],
      },
      {
        id: 'project-tour-episode-2',
        argv: [
          'agent-work-lab',
          'project-tour',
          '--episode',
          '2',
          '--speed',
          '4',
        ],
      },
    ],
  );
  assert.equal(scenario.execution.durationClass, 'long-form');
  assert.equal(scenario.execution.totalTimeoutSeconds, 360);
  assert.equal(scenario.demos[1].steps[0].timeoutSeconds, 360);
  assert.equal(scenario.demos[2].steps[0].timeoutSeconds, 360);
  assert.deepEqual(scenario.transportSmoke, {
    argv: ['agent-work-lab', 'demo', '--json'],
    timeoutSeconds: 60,
    expectedExitCodes: [0],
    stdoutIncludes: ['kungfu.agent-work-lab.report/v1'],
  });
  assert.equal(
    scenario.demos.some(
      ({ steps }) =>
        JSON.stringify(steps[0].argv) ===
        JSON.stringify(scenario.transportSmoke.argv),
    ),
    false,
  );
  assert.equal(
    demo.with['media-profile'],
    'responsive-long-form-web-delivery-v1',
  );
});

test('pre-upload transport uses a v3-compatible scenario bound to the exact product artifact', () => {
  assert.equal(
    build.with['pre-upload-transport-smoke-scenario-path'],
    '.buildchain/auditable-demo-transport-smoke.json',
  );
  assert.deepEqual(transportScenario.product, scenario.product);
  assert.deepEqual(transportScenario.artifact, scenario.artifact);
  assert.deepEqual(transportScenario.transportSmoke, scenario.transportSmoke);
  assert.deepEqual(transportScenario.authority, scenario.authority);
  assert.deepEqual(transportScenario.execution, {
    deterministic: true,
    network: 'none',
    secrets: 'none',
    totalTimeoutSeconds: 60,
    environment: {},
  });
  assert.deepEqual(transportScenario.renditions, [
    {
      id: '1080p',
      role: 'primary',
      columns: 150,
      rows: 36,
      width: 1920,
      height: 1080,
    },
    {
      id: '720p',
      role: 'responsive',
      columns: 150,
      rows: 28,
      width: 1280,
      height: 720,
    },
  ]);
});

test('native 720p keeps full-width terminal coverage without copying 1080p geometry', () => {
  assert.equal(scenario.compositionMode, 'terminal-fill');
  assert.deepEqual(scenario.renditions, [
    {
      id: '1080p',
      role: 'primary',
      columns: 150,
      rows: 36,
      width: 1920,
      height: 1080,
    },
    {
      id: '720p',
      role: 'responsive',
      columns: 150,
      rows: 28,
      width: 1280,
      height: 720,
    },
  ]);
  assert.notEqual(
    scenario.renditions[0].rows,
    scenario.renditions[1].rows,
    '720p must remain an independently reflowed native PTY',
  );
});

test('Kungfu owns the ordered three-proof argument while Buildchain updates only media', () => {
  assert.equal(
    scenario.presentation.schema,
    'buildchain.declarative-demo-presentation/v1',
  );
  assert.deepEqual(
    scenario.presentation.proofs.map(({ demoId, label, question }) => ({
      demoId,
      label,
      question,
    })),
    [
      {
        demoId: 'agent-work-lab-autoplay',
        label: 'Continuity',
        question: 'Can Work survive a new Agent?',
      },
      {
        demoId: 'project-tour-episode-1',
        label: 'Failure retention',
        question: 'Can Work survive failure?',
      },
      {
        demoId: 'project-tour-episode-2',
        label: 'Review and settlement',
        question: 'Who is allowed to complete Work?',
      },
    ],
  );
  assert.deepEqual(scenario.presentation.materialization, {
    readmeMode: 'media-only',
    technicalSpecPath: 'docs/qualification/auditable-demo-artifact-pipeline.md',
    technicalSpecTitle: 'Declarative Multi-demo Animation Pipeline',
    technicalMarker: 'kungfu:auditable-demo:technical',
  });
  for (const proof of scenario.presentation.proofs) {
    const marker = `${scenario.publication.marker}:${proof.demoId}`;
    const block = readme.match(
      new RegExp(
        `<!-- ${marker}:start -->([\\s\\S]*?)<!-- ${marker}:end -->`,
        'u',
      ),
    )?.[1];
    assert.ok(block, `README marker is missing for ${proof.demoId}`);
    assert.match(block, /\[!\[/u);
    assert.doesNotMatch(
      block,
      /Animation scenario|Native renditions|<details>/u,
    );
  }
  assert.match(
    readme,
    /Work survival is only the first step\.[\s\S]*Who is allowed to complete Work\?/u,
  );
  assert.match(
    technicalSpec,
    /Kungfu owns the public argument around the media/u,
  );
});

test('the build fails the real transported binary before either upload path', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    'gate-only',
    'full',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'full');
  assert.equal(
    build.uses,
    'kungfu-systems/buildchain/.github/workflows/.build-engine.yml@v4-alpha',
  );
  assert.equal(build.with['buildchain-ref'], 'v4-alpha');
  assert.deepEqual(build.permissions, {
    actions: 'read',
    contents: 'read',
    issues: 'write',
    'id-token': 'write',
  });
  assert.equal(
    demo.uses,
    'kungfu-systems/buildchain/.github/workflows/public-build-demo.yml@v4-alpha',
  );
  assert.equal(
    build.with['pre-upload-transport-smoke-scenario-path'],
    '.buildchain/auditable-demo-transport-smoke.json',
  );
  assert.equal(build.with['pre-upload-transport-smoke-artifact-root'], '.');
});

test('manual full refresh and promotion reuse the same materializer', () => {
  assert.equal(
    demo.with['render-media'],
    "${{ github.event_name != 'workflow_dispatch' || inputs.mode == 'full' }}",
  );
  assert.equal(
    demo.with['render-failure-advisory'],
    "${{ github.event_name == 'pull_request' && startsWith(github.base_ref, 'alpha/') }}",
  );
  assert.equal(
    demo.with.materialize,
    "${{ github.event_name != 'workflow_dispatch' || (inputs.mode == 'full' && inputs.materialize) }}",
  );
  assert.equal(
    demo.with['materialize-base-ref'],
    '${{ github.event.repository.default_branch }}',
  );
  assert.equal(
    demo.secrets.DEMO_UPDATE_TOKEN,
    '${{ secrets.KUNGFU_GITHUB_TOKEN }}',
  );
});

test('manual media publication runs only the Linux x64 product path', () => {
  const platformExpression = build.with['platforms-json'];
  const platforms = JSON.parse(platformExpression);
  assert.deepEqual(
    platforms.map(({ id }) => id),
    ['linux-x64'],
  );
  assert.equal(build.with['require-verify'], false);
  assert.equal(build.with['release-candidate'], false);
  assert.equal(build.with['publish-channel'], 'none');
  assert.equal(
    build.with['artifact-name-template'],
    '{artifact}-{platform}-{sha}',
  );
  assert.equal(workflow.jobs['resolve-binary'].needs, 'build');
  assert.equal(
    demo.if,
    "${{ always() && needs.build.result == 'success' && needs.resolve-binary.result == 'success' }}",
  );
  assert.equal(
    releaseBuild.on.workflow_dispatch?.inputs?.['render-auditable-demo'],
    undefined,
  );
  assert.equal(releaseBuild.jobs['resolve-auditable-demo-source'], undefined);
  assert.equal(releaseBuild.jobs['auditable-demo'], undefined);
  assert.doesNotMatch(releaseBuildText, /render-auditable-demo/u);
});

test('the exact same-run artifact contains the standalone demo distribution', () => {
  assert.match(
    workflowText,
    /artifact-paths:[\s\S]*product\/dist\/cli\/kungfu-cli-linux-x64/u,
  );
  assert.equal(
    scenario.artifact.binaryPath,
    'product/dist/cli/kungfu-cli-linux-x64/kungfu',
  );
  assert.equal(
    scenario.artifact.metadataContract,
    'kungfu.declarative-demo-binary/v1',
  );
  assert.deepEqual(scenario.artifact.runtimeDependencies, []);
  assert.equal(
    demo.with['renderer-image'],
    'ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:3a49708163fedaaabe07b45bba910026a1828151b5d4e9bbdaf0d62e75c927c1',
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
  assert.equal(releaseBuild.jobs['auditable-demo-plan'], undefined);
  assert.equal(releaseBuild.jobs['auditable-demo-passport'], undefined);
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
