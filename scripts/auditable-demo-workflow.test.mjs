// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  buildAuditableDemoTriggerPlan,
  verifyAuditableDemoTriggerPlan,
} from './auditable-demo-passport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'build.yml');
const RELEASE_WORKFLOW_PATH = path.join(
  ROOT,
  '.github',
  'workflows',
  'release-new-version.yml',
);
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = parse(WORKFLOW_TEXT);
const RELEASE_WORKFLOW = parse(fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const SOURCE_SHA = '1'.repeat(40);

function triggerPlan(overrides = {}) {
  return buildAuditableDemoTriggerPlan({
    eventName: 'workflow_dispatch',
    sourceSha: SOURCE_SHA,
    ...overrides,
  });
}

test('Alpha and release builds rerun when candidate source is synchronized', () => {
  assert.deepEqual(WORKFLOW.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
  ]);
});

test('manual dispatch preserves Gate-only and full-media validation modes', () => {
  const gateOnly = triggerPlan({});
  assert.equal(gateOnly.triggerClass, 'manual');
  assert.equal(gateOnly.demoId, 'agent-work-lab');
  assert.equal(gateOnly.renderMedia, false);
  assert.equal(gateOnly.refreshRequired, false);

  const refresh = triggerPlan({
    requestedDemoId: 'agent-work-lab-secondary',
    requestedRenderMedia: true,
  });
  assert.equal(refresh.demoId, 'agent-work-lab-secondary');
  assert.equal(refresh.renderMedia, true);
  assert.equal(refresh.refreshRequired, true);
  assert.equal(verifyAuditableDemoTriggerPlan(refresh), refresh);
});

test('Alpha and Release promotions require the same default media refresh plan', () => {
  const alpha = triggerPlan({
    eventName: 'pull_request',
    baseRef: 'alpha/v4/v4.0',
  });
  const release = triggerPlan({
    eventName: 'pull_request',
    baseRef: 'release/v4/v4.0',
  });
  for (const candidate of [alpha, release]) {
    assert.equal(candidate.demoId, 'agent-work-lab');
    assert.equal(candidate.renderMedia, true);
    assert.equal(candidate.refreshRequired, true);
    assert.equal(candidate.executionContract, alpha.executionContract);
    assert.equal(candidate.publicationAuthority, false);
  }
  assert.equal(alpha.triggerClass, 'alpha');
  assert.equal(release.triggerClass, 'release');
});

test('unsupported or ambiguous trigger inputs fail closed', () => {
  assert.throws(
    () => triggerPlan({ eventName: 'push' }),
    /unsupported event push/u,
  );
  assert.throws(
    () =>
      triggerPlan({
        eventName: 'pull_request',
        baseRef: 'dev/v4/v4.0',
      }),
    /not an Alpha or Release channel/u,
  );
  assert.throws(
    () =>
      triggerPlan({
        eventName: 'pull_request',
        baseRef: 'alpha/v4/v4.0',
        requestedDemoId: 'secondary',
      }),
    /must use the catalog default/u,
  );
  const tampered = triggerPlan({ requestedRenderMedia: true });
  tampered.renderMedia = false;
  assert.throws(
    () => verifyAuditableDemoTriggerPlan(tampered),
    /plan root mismatch/u,
  );
});

async function runResolver({
  declaredExpiry,
  observedExpiry,
  producerAttempt = '1',
  currentAttempt = '1',
}) {
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
          runAttempt: producerAttempt,
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
        GITHUB_RUN_ATTEMPT: currentAttempt,
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
    'kungfu-systems/buildchain/.github/workflows/.build.yml@0f2b2b0134b3fe071e7b57924f3d5fb1f5d241ec',
    'the build runtime must be the protected Buildchain authority with hosted signing finalization',
  );
  assert.equal(
    build.with['artifact-signing-request-upload-no-proxy'],
    '${{ vars.BUILDCHAIN_ARTIFACT_SIGNING_REQUEST_UPLOAD_NO_PROXY }}',
    'the large signing-request upload must use the caller-owned direct route while signed-result download retains the runner proxy',
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

test('resolver admits a retained producer coordinate from an earlier run attempt only', async () => {
  const outputs = await runResolver({
    declaredExpiry: '2026-08-12T23:18:49.000Z',
    observedExpiry: '2026-08-12T23:18:49Z',
    producerAttempt: '1',
    currentAttempt: '2',
  });
  assert.equal(outputs.get('applicable'), 'true');
  await assert.rejects(
    runResolver({
      declaredExpiry: '2026-08-12T23:18:49.000Z',
      observedExpiry: '2026-08-12T23:18:49Z',
      producerAttempt: '2',
      currentAttempt: '1',
    }),
    /build artifact coordinate set is not bound to this exact source run/u,
  );
});

test('Gate runtime and renderer are immutable and Passport uses the same runtime', () => {
  const gate = WORKFLOW.jobs['auditable-demo'];
  const plan = WORKFLOW.jobs['auditable-demo-plan'];
  const passport = WORKFLOW.jobs['auditable-demo-passport'];
  const runtime = gate.uses.match(
    /^kungfu-systems\/buildchain\/\.github\/workflows\/\.auditable-demo\.yml@([0-9a-f]{40})$/u,
  );
  assert.ok(runtime, 'Gate must use one exact Buildchain commit');
  assert.match(
    gate.with['renderer-image'],
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(
    gate.with['media-profile'],
    'responsive-web-delivery-v1',
    'Gate and render must use the declared responsive qualification profile',
  );
  const passportStep = passport.steps.find(
    ({ name }) => name === 'Write exact auditable demo Release Passport',
  );
  const expiryStep = passport.steps.find(({ id }) => id === 'artifact-expiry');
  assert.equal(
    WORKFLOW.on.workflow_dispatch.inputs['auditable-demo-id'].default,
    'agent-work-lab',
  );
  assert.equal(
    gate.with['adapter-arguments-json'],
    '${{ format(\'["--demo-id",{0}]\', toJSON(needs.auditable-demo-plan.outputs.demo-id)) }}',
  );
  assert.equal(
    passportStep.env.AUDITABLE_DEMO_ID,
    '${{ needs.auditable-demo-plan.outputs.demo-id }}',
  );
  assert.deepEqual(gate.needs, [
    'build',
    'resolve-auditable-demo-source',
    'auditable-demo-plan',
  ]);
  assert.match(
    plan.steps.find(({ id }) => id === 'plan').run,
    /write[\s\S]*verify/u,
  );
  assert.equal(passportStep.env.BUILDCHAIN_SHA, runtime[1]);
  assert.equal(passportStep.env.RENDERER_IMAGE, gate.with['renderer-image']);
  assert.equal(
    passportStep.env.MEDIA_PROFILE,
    '${{ needs.auditable-demo.outputs.media-profile }}',
  );
  assert.equal(
    passportStep.env.MEDIA_QUALIFICATION_ROOT,
    '${{ needs.auditable-demo.outputs.media-qualification-root }}',
  );
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

test('manual, Alpha, and Release events share one normalized media plan', () => {
  const gate = WORKFLOW.jobs['auditable-demo'];
  const plan = WORKFLOW.jobs['auditable-demo-plan'];
  const planStep = plan.steps.find(({ id }) => id === 'plan');
  assert.equal(
    gate.with['render-media'],
    "${{ needs.auditable-demo-plan.outputs.render-media == 'true' }}",
  );
  assert.equal(
    planStep.env.AUDITABLE_DEMO_RENDER_MEDIA,
    "${{ github.event_name == 'workflow_dispatch' && inputs.render-auditable-demo && 'true' || 'false' }}",
  );
  assert.equal(
    planStep.env.AUDITABLE_DEMO_ID,
    "${{ github.event_name == 'workflow_dispatch' && inputs.auditable-demo-id || '' }}",
    'promotion events must not inherit workflow-dispatch defaults',
  );
  assert.equal(
    RELEASE_WORKFLOW.jobs.promote.with['release-candidate-workflow-file'],
    'build.yml',
    'final promotion must consume the same Build workflow media plan',
  );
  assert.doesNotMatch(gate.with['render-media'], /github\.event_name|alpha\//u);
  assert.doesNotMatch(gate.if, /render-auditable-demo|alpha\//u);
  assert.match(WORKFLOW_TEXT, /reason: "linux-x64-not-produced"/u);
});

test('the auditable demo path grants no publication or deployment authority', () => {
  const excerpt = WORKFLOW_TEXT.slice(
    WORKFLOW_TEXT.indexOf('  resolve-auditable-demo-source:'),
    WORKFLOW_TEXT.indexOf('  phase-b-package:'),
  );
  assert.doesNotMatch(excerpt, /\bdeployments:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bpackages:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bcontents:\s*write\b/u);
  assert.doesNotMatch(excerpt, /\bid-token:\s*write\b/u);
});
