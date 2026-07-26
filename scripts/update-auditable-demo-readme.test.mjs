// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderAuditableDemoBlock,
  updateReadme,
  validatePublicEvidence,
} from './update-auditable-demo-readme.mjs';

const SHA = 'a'.repeat(40);
const RUN_URL = 'https://github.com/kungfu-systems/kungfu/actions/runs/12345';

function artifact(id, name, character) {
  return {
    id,
    name,
    digest: `sha256:${character.repeat(64)}`,
    url: `${RUN_URL}/artifacts/${id}`,
    expiresAt: '2026-08-08T12:00:00Z',
  };
}

function evidence() {
  return {
    schema: 'kungfu.auditable-demo.public-evidence/v1',
    status: 'qualified',
    sourceSha: SHA,
    workflowUrl: RUN_URL,
    buildchainSha: 'b'.repeat(40),
    rendererImage: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${'c'.repeat(64)}`,
    gate: {
      root: `sha256:${'d'.repeat(64)}`,
      artifact: artifact('101', 'auditable-demo-gate', '1'),
    },
    media: {
      root: `sha256:${'e'.repeat(64)}`,
      artifact: artifact('102', 'auditable-demo-media', '2'),
    },
    passport: {
      root: `sha256:${'f'.repeat(64)}`,
      artifact: artifact('103', 'auditable-demo-passport', '3'),
    },
  };
}

test('renders one exact source, run, Gate, media, and Passport boundary', () => {
  const block = renderAuditableDemoBlock(evidence());
  assert.match(block, new RegExp(SHA, 'u'));
  assert.match(block, /https:\/\/kungfu\.tech\/how-tested\/auditable-demo\//u);
  assert.match(block, /exact installed-artifact execution/u);
  assert.match(block, /not a continuity.*production-deployment claim/su);
});

test('inserts and idempotently replaces only its managed block', () => {
  const original =
    '# Kungfu\n\nIntro.\n\n## Kungfu in the Agent Supply Chain\n\nBody.\n';
  const first = updateReadme(original, evidence());
  const updated = evidence();
  updated.gate.root = `sha256:${'9'.repeat(64)}`;
  const second = updateReadme(first, updated);
  assert.equal((second.match(/kungfu:auditable-demo:start/gu) || []).length, 1);
  assert.match(second, new RegExp('9'.repeat(64), 'u'));
  assert.doesNotMatch(second, new RegExp('d'.repeat(64), 'u'));
  assert.match(second, /## Kungfu in the Agent Supply Chain\n\nBody\./u);
});

test('rejects partial markers and cross-run artifacts', () => {
  assert.throws(
    () =>
      updateReadme(
        '# Kungfu\n\n<!-- kungfu:auditable-demo:start -->\n\n## Kungfu in the Agent Supply Chain\n',
        evidence(),
      ),
    /managed block markers are malformed/u,
  );
  const mismatched = evidence();
  mismatched.media.artifact.url =
    'https://github.com/kungfu-systems/kungfu/actions/runs/999/artifacts/102';
  assert.throws(
    () => validatePublicEvidence(mismatched),
    /all artifacts must belong to the exact qualified workflow run/u,
  );
});
