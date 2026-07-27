// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  renderAuditableDemoBlock,
  updateReadme,
  validatePublicEvidence,
  verifyReadmeMediaFile,
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
    readmeMedia: {
      path: `docs/qualification/evidence/auditable-demo/${'f'.repeat(64)}/demo.gif`,
      digest: `sha256:${'4'.repeat(64)}`,
    },
  };
}

test('renders one exact source, run, Gate, media, and Passport boundary', () => {
  const block = renderAuditableDemoBlock(evidence());
  assert.match(block, /^## Auditable exact-output demo$/mu);
  assert.match(block, new RegExp(SHA, 'u'));
  assert.match(
    block,
    new RegExp(
      `docs/qualification/evidence/auditable-demo/${'f'.repeat(64)}/demo\\.gif`,
      'u',
    ),
  );
  assert.match(
    block,
    /Animated Kungfu terminal demo produced from the exact installed Linux artifact/u,
  );
  assert.match(
    block,
    /\[Read the method and evidence\]\(docs\/qualification\/auditable-demo-artifact-pipeline\.md\)/u,
  );
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
  const wrongMediaPath = evidence();
  wrongMediaPath.readmeMedia.path = `docs/qualification/evidence/auditable-demo/${'0'.repeat(64)}/demo.gif`;
  assert.throws(
    () => validatePublicEvidence(wrongMediaPath),
    /README media path is not bound to the Passport root/u,
  );
});

test('verifies the committed README GIF against its public evidence digest', () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-readme-'),
  );
  try {
    const value = evidence();
    const bytes = Buffer.from('gif fixture');
    value.readmeMedia.digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const mediaPath = path.join(repoRoot, value.readmeMedia.path);
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.writeFileSync(mediaPath, bytes);
    assert.equal(
      verifyReadmeMediaFile(repoRoot, value).readmeMedia.digest,
      value.readmeMedia.digest,
    );
    fs.appendFileSync(mediaPath, 'drift');
    assert.throws(
      () => verifyReadmeMediaFile(repoRoot, value),
      /README media digest does not match public evidence/u,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
