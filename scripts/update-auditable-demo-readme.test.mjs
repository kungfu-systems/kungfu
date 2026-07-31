// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPassport, stableJson } from './auditable-demo-passport.mjs';
import {
  buildPublicEvidence,
  materializePublicEvidence,
  renderAuditableDemoBlock,
  updateReadme,
  validatePublicEvidence,
  verifyReadmeMediaFile,
} from './update-auditable-demo-readme.mjs';

const SHA = 'a'.repeat(40);
const RUN_URL = 'https://github.com/kungfu-systems/kungfu/actions/runs/12345';
const GATE_ROOT = `sha256:${'d'.repeat(64)}`;
const RENDERER = `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${'c'.repeat(64)}`;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

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
      profile: 'responsive-web-delivery-v1',
      qualificationRoot: `sha256:${'6'.repeat(64)}`,
    },
    passport: {
      root: `sha256:${'f'.repeat(64)}`,
      artifact: artifact('103', 'auditable-demo-passport', '3'),
    },
    evidenceClass: 'exact-installed-artifact-agent-work-lab-autoplay/v1',
    claims: [
      'The exact retained Linux artifact executed its installed autoplay command.',
    ],
    nonClaims: ['production deployment'],
    authorization: {
      status: 'not-granted-by-demo',
      requiredSources: [
        'exact-release-passport',
        'core-policy',
        'work-or-warrant',
        'explicit-capability-grant',
        'runtime-isolation',
      ],
      nonAuthorities: [
        'first-party-identity',
        'system-identity',
        'kfd-compliance',
        'product-system-metadata',
        'local-bundle-presence',
        'package-metadata',
        'registry-history',
        'scan-output',
        'standalone-generation',
      ],
    },
    readmeMedia: {
      path: `docs/qualification/evidence/auditable-demo/${'f'.repeat(64)}/demo.gif`,
      digest: `sha256:${'4'.repeat(64)}`,
    },
  };
}

test('renders one exact source, run, Gate, media, and Passport boundary', () => {
  const block = renderAuditableDemoBlock(evidence());
  assert.match(block, /^## See a fresh Agent continue the same Work$/mu);
  assert.match(
    block,
    /One Work\. Two fresh Agent processes\. No copied chat\./u,
  );
  assert.match(block, /Session 1 stops with a partial result/u);
  assert.match(block, /Session 2 starts without the previous.*conversation/su);
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
    /Kungfu Agent Work Lab showing a fresh Agent continuing the same Work without copied chat/u,
  );
  assert.match(
    block,
    /<summary>How this exact installed-artifact demo was verified<\/summary>/u,
  );
  assert.match(
    block,
    /\[Method and evidence\]\(docs\/qualification\/auditable-demo-artifact-pipeline\.md\)/u,
  );
  assert.match(block, /exact.*installed-artifact autoplay/su);
  assert.match(block, /agent-work-lab autoplay/u);
  assert.match(block, /grants no.*first-party\/System identity/su);
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

test('validates a secondary demo path while preventing it from replacing the README hero', () => {
  const value = evidence();
  value.schema = 'kungfu.auditable-demo.public-evidence/v2';
  value.demo = {
    id: 'status-snapshot',
    catalogRoot: `sha256:${'7'.repeat(64)}`,
    descriptorRoot: `sha256:${'8'.repeat(64)}`,
    commandLabel: 'kungfu status --snapshot --no-interaction',
    evidenceClass: 'exact-installed-artifact-status-snapshot/v1',
    sceneId: 'kungfu-status-snapshot',
    publication: {
      readmeFeatured: false,
      siteSlug: 'status-snapshot',
    },
  };
  value.evidenceClass = value.demo.evidenceClass;
  value.readmeMedia.path = `docs/qualification/evidence/auditable-demo/status-snapshot/${'f'.repeat(64)}/demo.gif`;
  const validated = validatePublicEvidence(value);
  assert.equal(validated.demo.id, 'status-snapshot');
  assert.throws(
    () => renderAuditableDemoBlock(value),
    /only the catalog-selected README demo/u,
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

test('materializes README evidence only from a verified Passport and exact media bundle', () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-materialize-'),
  );
  try {
    const mediaDirectory = path.join(repoRoot, 'media');
    fs.mkdirSync(mediaDirectory);
    const members = {
      'complete-transcript.txt': Buffer.from('autoplay completed\n'),
      'demo.gif': Buffer.from('GIF89a qualified fixture'),
      'demo-720p.mp4': Buffer.from('720p mp4 fixture'),
      'demo-720p.webm': Buffer.from('720p webm fixture'),
      'demo.mp4': Buffer.from('mp4 fixture'),
      'demo.webm': Buffer.from('webm fixture'),
      'gate-receipt.json': Buffer.from('{}\n'),
      'manifest.json': Buffer.from(
        stableJson({
          schema: 'build-images.auditable-demo-render/v1',
          renderer: { image: RENDERER },
          policy: {
            evidenceClass:
              'exact-installed-artifact-agent-work-lab-autoplay/v1',
            visualClassification: 'bounded-pty-replay',
            runtimeTextAuthority: 'terminal-capture.json',
          },
          inputs: {
            terminalCapture: { root: `sha256:${'9'.repeat(64)}` },
          },
          derivation: {
            policy: 'single-frame-set-deterministic-renditions/v1',
            renditions: {
              'demo.gif': {
                width: 1280,
                height: 720,
                operation: 'lanczos-downscale-from-source-frames',
              },
            },
          },
        }),
      ),
      'media-inspection.json': Buffer.from('{"passed":true}\n'),
      'media-probe.json': Buffer.from('{"passed":true}\n'),
      'poster.png': Buffer.from('png fixture'),
      'public-projection.json': Buffer.from('{}\n'),
      'renderer-checksums.sha256': Buffer.from('renderer fixture\n'),
      'scene.json': Buffer.from('{"durationMs":1000}\n'),
    };
    const renditionSpecs = [
      ['primary-video', 'demo.mp4', 'video/mp4', 1920, 1080, 'scene-exact'],
      ['alternate-video', 'demo.webm', 'video/webm', 1920, 1080, 'scene-exact'],
      [
        'responsive-primary-video',
        'demo-720p.mp4',
        'video/mp4',
        1280,
        720,
        'exact-downscale-same-aspect',
      ],
      [
        'responsive-alternate-video',
        'demo-720p.webm',
        'video/webm',
        1280,
        720,
        'exact-downscale-same-aspect',
      ],
      [
        'readme-compatibility',
        'demo.gif',
        'image/gif',
        1280,
        720,
        'exact-downscale-same-aspect',
      ],
      ['evidence-poster', 'poster.png', 'image/png', 1920, 1080, 'scene-exact'],
    ];
    const qualificationBody = {
      schema: 'buildchain.auditable-demo-media-qualification/v1',
      profile: { id: 'responsive-web-delivery-v1' },
      inspectionRoot: `sha256:${'8'.repeat(64)}`,
      renditions: renditionSpecs.map(
        ([role, file, mimeType, width, height, dimensionPolicy]) => ({
          role,
          path: file,
          mimeType,
          width,
          height,
          dimensionPolicy,
          root: sha256(members[file]),
          bytes: members[file].length,
        }),
      ),
      nonClaims: [],
    };
    const qualification = {
      ...qualificationBody,
      qualificationRoot: sha256(Buffer.from(stableJson(qualificationBody))),
    };
    const receipt = {
      schema: 'buildchain.auditable-demo-media/v2',
      status: 'passed',
      sourceSha: SHA,
      qualifiedGateRoot: GATE_ROOT,
      rendererImage: RENDERER,
      qualification,
      qualificationRoot: qualification.qualificationRoot,
    };
    members['media-receipt.json'] = Buffer.from(stableJson(receipt));
    for (const [name, bytes] of Object.entries(members)) {
      fs.writeFileSync(path.join(mediaDirectory, name), bytes);
    }
    const checksumText = `${Object.keys(members)
      .sort()
      .map((name) => `${sha256(members[name]).slice(7)}  ${name}`)
      .join('\n')}\n`;
    fs.writeFileSync(
      path.join(mediaDirectory, 'checksums.sha256'),
      checksumText,
    );
    const mediaRoot = sha256(Buffer.from(checksumText));
    const passport = buildPassport({
      GITHUB_REPOSITORY: 'kungfu-systems/kungfu',
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '1',
      SOURCE_SHA: SHA,
      SOURCE_ARTIFACT_ID: '100',
      SOURCE_ARTIFACT_NAME: `kungfu-linux-x64-${SHA}`,
      SOURCE_ARTIFACT_DIGEST: `sha256:${'1'.repeat(64)}`,
      SOURCE_ARTIFACT_URL: `${RUN_URL}/artifacts/100`,
      SOURCE_ARTIFACT_EXPIRES_AT: '2026-08-08T12:00:00Z',
      GATE_ARTIFACT_ID: '101',
      GATE_ARTIFACT_NAME: `auditable-demo-gate-${SHA.slice(0, 12)}-${GATE_ROOT.slice(7, 23)}`,
      GATE_ARTIFACT_DIGEST: `sha256:${'2'.repeat(64)}`,
      GATE_ARTIFACT_URL: `${RUN_URL}/artifacts/101`,
      GATE_ARTIFACT_EXPIRES_AT: '2026-08-08T12:00:00Z',
      GATE_ROOT,
      MEDIA_ARTIFACT_ID: '102',
      MEDIA_ARTIFACT_NAME: `auditable-demo-media-${SHA.slice(0, 12)}-${mediaRoot.slice(7, 23)}`,
      MEDIA_ARTIFACT_DIGEST: `sha256:${'3'.repeat(64)}`,
      MEDIA_ARTIFACT_URL: `${RUN_URL}/artifacts/102`,
      MEDIA_ARTIFACT_EXPIRES_AT: '2026-08-08T12:00:00Z',
      MEDIA_ROOT: mediaRoot,
      MEDIA_PROFILE: 'responsive-web-delivery-v1',
      MEDIA_QUALIFICATION_ROOT: qualification.qualificationRoot,
      BUILDCHAIN_SHA: 'b'.repeat(40),
      RENDERER_IMAGE: RENDERER,
    });
    const passportArtifact = artifact(
      '103',
      `kungfu-auditable-demo-passport-${SHA}-12345-1`,
      '4',
    );
    const projection = buildPublicEvidence({
      passport,
      passportArtifact,
      mediaDirectory,
    });
    assert.equal(
      projection.evidence.evidenceClass,
      passport.authority.evidenceClass,
    );
    assert.deepEqual(
      projection.evidence.authorization,
      passport.authority.authorization,
    );

    const passportPath = path.join(repoRoot, 'passport.json');
    const passportArtifactPath = path.join(repoRoot, 'passport-artifact.json');
    fs.writeFileSync(passportPath, stableJson(passport));
    fs.writeFileSync(passportArtifactPath, stableJson(passportArtifact));
    const result = materializePublicEvidence({
      repoRoot,
      passportPath,
      passportArtifactPath,
      mediaDirectory,
    });
    assert.equal(
      fs.readFileSync(result.gifPath).toString(),
      members['demo.gif'].toString(),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(result.evidencePath, 'utf8')).claims,
      passport.authority.claims,
    );

    fs.appendFileSync(path.join(mediaDirectory, 'demo.gif'), 'drift');
    assert.throws(
      () =>
        buildPublicEvidence({
          passport,
          passportArtifact,
          mediaDirectory,
        }),
      /media checksum mismatch/u,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
