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

test('every produced Linux artifact enters the required exact-output Gate', () => {
  const build = WORKFLOW.jobs.build;
  const resolver = WORKFLOW.jobs['resolve-auditable-demo-source'];
  const gate = WORKFLOW.jobs['auditable-demo'];
  assert.equal(
    build.with['artifact-transfer-mode'],
    "${{ github.event_name == 'workflow_dispatch' && 'github-artifacts' || 's3-to-github-artifacts' }}",
    'manual evidence runs must not enter the AWS relay while protected promotion retains its existing transfer path',
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
    'kungfu-systems/buildchain/.github/workflows/.build.yml@2f6259760cb6831ad129065d3bb6ccc3a5869939',
    'the build runtime must be the protected Buildchain release that owns artifact-coordinates-json',
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
    passportStep.env.GATE_ARTIFACT_EXPIRES_AT,
    '${{ steps.artifact-expiry.outputs.gate-artifact-expires-at }}',
  );
  assert.equal(
    passportStep.env.MEDIA_ARTIFACT_EXPIRES_AT,
    '${{ steps.artifact-expiry.outputs.media-artifact-expires-at }}',
  );
  assert.match(passport.if, /needs\.auditable-demo\.result == 'success'/u);
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
