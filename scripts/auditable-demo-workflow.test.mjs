// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'build.yml');
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = parse(WORKFLOW_TEXT);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

test('Alpha and release builds rerun when candidate source is synchronized', () => {
  assert.deepEqual(WORKFLOW.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
  ]);
});

async function runResolver({ declaredExpiry, observedExpiry }) {
  const resolver = WORKFLOW.jobs['resolve-auditable-demo-source'];
  const script = resolver.steps.find(({ id }) => id === 'resolve').with.script;
  const sourceSha = '1'.repeat(40);
  const runId = '30182763118';
  const artifactId = '8626649251';
  const name = `kungfu-linux-x64-${sourceSha}`;
  const digest = `sha256:${'2'.repeat(64)}`;
  const url = `https://github.com/kungfu-systems/kungfu/actions/runs/${runId}/artifacts/${artifactId}`;
  const outputs = new Map();
  await new AsyncFunction(
    'require',
    'process',
    'github',
    'context',
    'core',
    script,
  )(
    (name) => {
      assert.equal(name, 'fs');
      return {
        writeFileSync: () =>
          assert.fail('applicable resolver wrote a diagnosis'),
      };
    },
    {
      env: {
        SOURCE_SHA: sourceSha,
        PLATFORMS_JSON: JSON.stringify([{ id: 'linux-x64' }]),
        ARTIFACT_COORDINATES_JSON: JSON.stringify({
          schema: 'buildchain.github-artifact-coordinate-set/v1',
          repository: 'kungfu-systems/kungfu',
          runId,
          runAttempt: '1',
          sourceSha,
          artifacts: [
            {
              platformId: 'linux-x64',
              id: artifactId,
              name,
              digest,
              url,
              expiresAt: declaredExpiry,
            },
          ],
        }),
        GITHUB_RUN_ATTEMPT: '1',
      },
    },
    {
      paginate: async () => [
        {
          id: Number(artifactId),
          name,
          digest,
          expired: false,
          expires_at: observedExpiry,
        },
      ],
      rest: { actions: { listWorkflowRunArtifacts: () => undefined } },
    },
    { repo: { owner: 'kungfu-systems', repo: 'kungfu' }, runId },
    { setOutput: (key, value) => outputs.set(key, value) },
  );
  return outputs;
}

async function runPassportArtifactBinding({
  gateDigest = '3'.repeat(64),
  mediaDigest = '4'.repeat(64),
  observedGateDigest = `sha256:${'3'.repeat(64)}`,
  observedMediaDigest = `sha256:${'4'.repeat(64)}`,
}) {
  const passport = WORKFLOW.jobs['auditable-demo-passport'];
  const script = passport.steps.find(({ id }) => id === 'artifact-expiry').with
    .script;
  const runId = '30225695823';
  const gateId = '8639472306';
  const mediaId = '8639492343';
  const gateName = 'auditable-demo-gate-source-root';
  const mediaName = 'auditable-demo-media-source-root';
  const outputs = new Map();
  await new AsyncFunction('process', 'github', 'context', 'core', script)(
    {
      env: {
        GATE_ARTIFACT_ID: gateId,
        GATE_ARTIFACT_NAME: gateName,
        GATE_ARTIFACT_DIGEST: gateDigest,
        MEDIA_ARTIFACT_ID: mediaId,
        MEDIA_ARTIFACT_NAME: mediaName,
        MEDIA_ARTIFACT_DIGEST: mediaDigest,
      },
    },
    {
      paginate: async () => [
        {
          id: Number(gateId),
          name: gateName,
          digest: observedGateDigest,
          expired: false,
          expires_at: '2026-08-10T01:08:00Z',
        },
        {
          id: Number(mediaId),
          name: mediaName,
          digest: observedMediaDigest,
          expired: false,
          expires_at: '2026-08-10T01:09:31Z',
        },
      ],
      rest: { actions: { listWorkflowRunArtifacts: () => undefined } },
    },
    { repo: { owner: 'kungfu-systems', repo: 'kungfu' }, runId },
    { setOutput: (key, value) => outputs.set(key, value) },
  );
  return outputs;
}

test('every produced Linux artifact enters the required exact-output Gate', () => {
  const build = WORKFLOW.jobs.build;
  const resolver = WORKFLOW.jobs['resolve-auditable-demo-source'];
  const gate = WORKFLOW.jobs['auditable-demo'];
  assert.equal(
    WORKFLOW.on.workflow_dispatch.inputs['artifact-transfer-mode'],
    undefined,
    'manual evidence runs must not expose a direct GitHub artifact-transfer escape hatch',
  );
  assert.equal(
    build.with['artifact-transfer-mode'],
    's3-to-github-artifacts',
    'every Alpha, release, and manual evidence build must use the configured S3 relay',
  );
  assert.equal(
    resolver.env,
    undefined,
    'resolver credentials must be scoped to its step',
  );
  const resolveStep = resolver.steps.find(({ id }) => id === 'resolve');
  assert.equal(
    resolveStep.env.ARTIFACT_COORDINATES_JSON,
    '${{ needs.build.outputs.artifact-coordinates-json }}',
  );
  assert.equal(
    build.uses,
    'kungfu-systems/buildchain/.github/workflows/.build.yml@4716fc9d963f73c890f04cd3b91e59569de4fc38',
    'the build runtime must be the protected Buildchain alpha.7 release that combines artifact coordinates with safe diagnostics',
  );
  assert.match(
    resolveStep.with.script,
    /buildchain\.github-artifact-coordinate-set\/v1/u,
  );
  assert.match(
    gate.if,
    /resolve-auditable-demo-source\.outputs\.applicable == 'true'/u,
  );
  assert.equal(
    gate.with['source-artifact-digest'],
    '${{ needs.resolve-auditable-demo-source.outputs.artifact-digest }}',
  );
  assert.equal(gate.with['require-trusted-event'], true);
});

test('resolver accepts GitHub expiry precision normalization without weakening the coordinate', async () => {
  const outputs = await runResolver({
    declaredExpiry: '2026-08-09T01:47:51.000Z',
    observedExpiry: '2026-08-09T01:47:51Z',
  });
  assert.equal(outputs.get('applicable'), 'true');
  assert.equal(outputs.get('artifact-expires-at'), '2026-08-09T01:47:51.000Z');
  await assert.rejects(
    runResolver({
      declaredExpiry: '2026-08-09T01:47:51.000Z',
      observedExpiry: '2026-08-09T01:47:52Z',
    }),
    /live Linux artifact drifted from the producer-owned coordinate/u,
  );
});

test('Gate runtime and renderer are immutable and Passport uses the same runtime', () => {
  const gate = WORKFLOW.jobs['auditable-demo'];
  const passport = WORKFLOW.jobs['auditable-demo-passport'];
  const runtime = gate.uses.match(
    /^kungfu-systems\/buildchain\/\.github\/workflows\/\.auditable-demo\.yml@([0-9a-f]{40})$/u,
  );
  assert.ok(runtime, 'Gate must use one exact Buildchain commit');
  assert.match(
    gate.with['renderer-image'],
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u,
  );
  const passportStep = passport.steps.find(
    ({ name }) => name === 'Write exact auditable demo Release Passport',
  );
  const expiryStep = passport.steps.find(({ id }) => id === 'artifact-expiry');
  assert.equal(passportStep.env.BUILDCHAIN_SHA, runtime[1]);
  assert.equal(passportStep.env.RENDERER_IMAGE, gate.with['renderer-image']);
  assert.equal(passport.permissions.actions, 'read');
  assert.match(
    expiryStep.with.script,
    /listWorkflowRunArtifacts[\s\S]*artifact\.digest !== coordinate\.digest/u,
  );
  assert.equal(
    passportStep.env.GATE_ARTIFACT_DIGEST,
    '${{ steps.artifact-expiry.outputs.gate-artifact-digest }}',
  );
  assert.equal(
    passportStep.env.MEDIA_ARTIFACT_DIGEST,
    '${{ steps.artifact-expiry.outputs.media-artifact-digest }}',
  );
  assert.equal(
    passportStep.env.GATE_ARTIFACT_EXPIRES_AT,
    '${{ steps.artifact-expiry.outputs.gate-artifact-expires-at }}',
  );
  assert.equal(
    passportStep.env.MEDIA_ARTIFACT_EXPIRES_AT,
    '${{ steps.artifact-expiry.outputs.media-artifact-expires-at }}',
  );
  assert.match(passport.if, /needs\.auditable-demo\.result == 'success'/u);
});

test('Passport binding normalizes upload digests to exact API coordinates', async () => {
  const outputs = await runPassportArtifactBinding({});
  assert.equal(outputs.get('gate-artifact-digest'), `sha256:${'3'.repeat(64)}`);
  assert.equal(
    outputs.get('media-artifact-digest'),
    `sha256:${'4'.repeat(64)}`,
  );
  await assert.rejects(
    runPassportArtifactBinding({
      gateDigest: '3'.repeat(64),
      observedGateDigest: `sha256:${'5'.repeat(64)}`,
    }),
    /gate artifact name or digest differs from the retained artifact/u,
  );
  await assert.rejects(
    runPassportArtifactBinding({ gateDigest: 'not-a-digest' }),
    /gate artifact coordinate is partial or invalid/u,
  );
});

test('full media is selective while the Gate remains unconditional when applicable', () => {
  const gate = WORKFLOW.jobs['auditable-demo'];
  assert.match(gate.with['render-media'], /render-auditable-demo/u);
  assert.match(
    gate.with['render-media'],
    /startsWith\(github\.base_ref, 'alpha\/'\)/u,
  );
  assert.doesNotMatch(gate.if, /render-auditable-demo|alpha\//u);
  assert.match(WORKFLOW_TEXT, /reason: "linux-x64-not-produced"/u);
});

test('the auditable demo path grants no publication or deployment authority', () => {
  const excerpt = WORKFLOW_TEXT.slice(
    WORKFLOW_TEXT.indexOf('  resolve-auditable-demo-source:'),
    WORKFLOW_TEXT.indexOf('  credential-island-macos:'),
  );
  assert.doesNotMatch(excerpt, /\bdeployments:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bpackages:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bcontents:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bid-token:\s*write\b/u);
});
