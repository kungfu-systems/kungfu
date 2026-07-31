// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPassport,
  stableJson,
  verifyPassport,
} from './auditable-demo-passport.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const GATE_ROOT = `sha256:${'b'.repeat(64)}`;
const MEDIA_ROOT = `sha256:${'c'.repeat(64)}`;
const MEDIA_QUALIFICATION_ROOT = `sha256:${'f'.repeat(64)}`;

function artifact(
  prefix,
  id,
  name,
  digest,
  expiresAt = '2026-08-08T12:00:00Z',
) {
  return {
    [`${prefix}_ARTIFACT_ID`]: id,
    [`${prefix}_ARTIFACT_NAME`]: name,
    [`${prefix}_ARTIFACT_DIGEST`]: digest,
    [`${prefix}_ARTIFACT_URL`]: `https://github.com/kungfu-systems/kungfu/actions/runs/42/artifacts/${id}`,
    [`${prefix}_ARTIFACT_EXPIRES_AT`]: expiresAt,
  };
}

function validEnv() {
  return {
    GITHUB_REPOSITORY: 'kungfu-systems/kungfu',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    SOURCE_SHA,
    ...artifact(
      'SOURCE',
      '100',
      `kungfu-linux-x64-${SOURCE_SHA}`,
      `sha256:${'1'.repeat(64)}`,
    ),
    ...artifact(
      'GATE',
      '101',
      `auditable-demo-gate-${SOURCE_SHA.slice(0, 12)}-${GATE_ROOT.slice(7, 23)}`,
      `sha256:${'2'.repeat(64)}`,
    ),
    GATE_ROOT,
    BUILDCHAIN_SHA: 'd'.repeat(40),
    RENDERER_IMAGE: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${'e'.repeat(64)}`,
  };
}

test('writes and verifies a Gate-only exact-output passport', () => {
  const passport = buildPassport(validEnv());
  assert.equal(passport.media.status, 'not-requested');
  assert.equal(passport.source.artifact.expiresAt, '2026-08-08T12:00:00.000Z');
  assert.equal(passport.gate.artifact.expiresAt, '2026-08-08T12:00:00.000Z');
  assert.equal(passport.authority.productionDeployment, false);
  assert.equal(
    passport.authority.evidenceClass,
    'exact-installed-artifact-agent-work-lab-autoplay/v1',
  );
  assert.equal(passport.authority.authorization.status, 'not-granted-by-demo');
  assert.deepEqual(passport.authority.authorization.requiredSources, [
    'exact-release-passport',
    'core-policy',
    'work-or-warrant',
    'explicit-capability-grant',
    'runtime-isolation',
  ]);
  assert.deepEqual(passport.authority.authorization.nonAuthorities, [
    'first-party-identity',
    'system-identity',
    'kfd-compliance',
    'product-system-metadata',
    'local-bundle-presence',
    'package-metadata',
    'registry-history',
    'scan-output',
    'standalone-generation',
  ]);
  assert.match(passport.root.value, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(verifyPassport(JSON.parse(stableJson(passport))), passport);
});

test('binds a selectively rendered media artifact to its exact root', () => {
  const env = {
    ...validEnv(),
    ...artifact(
      'MEDIA',
      '102',
      `auditable-demo-media-${SOURCE_SHA.slice(0, 12)}-${MEDIA_ROOT.slice(7, 23)}`,
      `sha256:${'3'.repeat(64)}`,
    ),
    MEDIA_ROOT,
    MEDIA_PROFILE: 'responsive-web-delivery-v1',
    MEDIA_QUALIFICATION_ROOT,
  };
  const passport = buildPassport(env);
  assert.equal(passport.media.status, 'rendered');
  assert.equal(passport.media.root, MEDIA_ROOT);
  assert.equal(passport.media.profile, 'responsive-web-delivery-v1');
  assert.equal(passport.media.qualificationRoot, MEDIA_QUALIFICATION_ROOT);
  assert.equal(passport.media.artifact.expiresAt, '2026-08-08T12:00:00.000Z');
});

test('binds an explicitly selected second demo to its catalog descriptor roots', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-passport-'),
  );
  try {
    const sourcePath = path.join(
      import.meta.dirname,
      '..',
      'framework',
      'auditable-demo',
      'catalog.json',
    );
    const catalog = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    catalog.demos.push({
      ...structuredClone(catalog.demos[0]),
      id: 'agent-work-lab-secondary',
      evidenceClass:
        'exact-installed-artifact-agent-work-lab-secondary-autoplay/v1',
      scene: {
        ...catalog.demos[0].scene,
        id: 'kungfu-agent-work-lab-secondary-autoplay',
        title: 'Kungfu Agent Work Lab secondary simulation',
      },
      publication: {
        readmeFeatured: false,
        siteSlug: 'agent-work-lab-secondary',
      },
    });
    const catalogPath = path.join(root, 'catalog.json');
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const passport = buildPassport(validEnv(), {
      catalogPath,
      demoId: 'agent-work-lab-secondary',
    });
    assert.equal(passport.schema, 'kungfu.auditable-demo.release-passport/v2');
    assert.equal(passport.demo.id, 'agent-work-lab-secondary');
    assert.equal(passport.demo.publication.readmeFeatured, false);
    assert.equal(
      passport.authority.evidenceClass,
      'exact-installed-artifact-agent-work-lab-secondary-autoplay/v1',
    );
    assert.match(passport.demo.catalogRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(passport.demo.descriptorRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(verifyPassport(passport), passport);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects partial media coordinates', () => {
  const env = {
    ...validEnv(),
    MEDIA_ARTIFACT_ID: '102',
  };
  assert.throws(
    () => buildPassport(env),
    /media artifact coordinate is partial/u,
  );
});

test('rejects a Gate coordinate without an exact expiry', () => {
  const env = validEnv();
  env.GATE_ARTIFACT_EXPIRES_AT = undefined;
  assert.throws(
    () => buildPassport(env),
    /gate artifact coordinate is partial/u,
  );
});

test('rejects a source artifact name not bound to the exact source SHA', () => {
  const env = {
    ...validEnv(),
    SOURCE_ARTIFACT_NAME: 'kungfu-linux-x64-wrong',
  };
  assert.throws(() => buildPassport(env), /source artifact name must equal/u);
});

test('rejects a mutated canonical payload', () => {
  const passport = buildPassport(validEnv());
  passport.gate.status = 'failed';
  assert.throws(
    () => verifyPassport(passport),
    /document root does not match/u,
  );
});
