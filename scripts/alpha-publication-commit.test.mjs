// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  bindPublicationReleaseAssets,
  existingReleaseAssetIsWinner,
  publicationArtifactDrift,
  publicationCommitEvidence,
  publicationTimestamp,
  signingIdentity,
  validateExistingLauncherRelease,
  validateExistingPublicationIdentity,
} from './alpha-publication-commit.mjs';

test('publication binds channel URLs to exact uploaded release bytes', () => {
  const releaseTag = 'v4.0.0-alpha.2';
  const digest = `sha256:${'a'.repeat(64)}`;
  const admission = {
    manifests: [
      {
        platform: 'darwin',
        architecture: 'arm64',
        manifest: {
          artifacts: [
            {
              kind: 'runtime',
              url: 'app-resource://kungfu',
              size: 1,
              digest: `sha256:${'b'.repeat(64)}`,
            },
            {
              kind: 'cli',
              url: `${releaseBase(releaseTag)}/Kungfu%20CLI.tar.gz`,
              size: 42,
              digest,
            },
          ],
        },
      },
    ],
  };
  const releaseAssets = [
    {
      name: 'Kungfu.CLI.tar.gz',
      state: 'uploaded',
      size: 42,
      digest,
    },
  ];
  const bound = bindPublicationReleaseAssets({
    admission,
    releaseAssets,
    releaseTag,
  });
  const cli = bound.manifests[0].manifest.artifacts[1];
  assert.equal(cli.url, `${releaseBase(releaseTag)}/Kungfu.CLI.tar.gz`);
  assert.deepEqual(
    publicationArtifactDrift({
      channelIndex: {
        entries: [
          {
            platform: 'darwin',
            architecture: 'arm64',
            manifest: bound.manifests[0].manifest,
          },
        ],
      },
      releaseAssets,
      releaseTag,
    }),
    [],
  );
});

function releaseBase(releaseTag) {
  return `https://github.com/kungfu-systems/kungfu/releases/download/${releaseTag}`;
}

test('existing publication authority is reusable only for the exact Alpha identity', () => {
  const candidateSourceSha = '1'.repeat(40);
  const builtSourceSha = '4'.repeat(40);
  const releaseSha = '2'.repeat(40);
  const releaseTag = 'v4.0.0-alpha.1';
  const bundle = {
    identity: {
      channel: 'alpha',
      version: '4.0.0-alpha.1',
      sourceCommit: candidateSourceSha,
      releaseSha,
      releaseTag,
      releasePassport: {
        ref: `buildchain:release-passport/${candidateSourceSha}`,
      },
    },
    distribution: {
      repository: 'kungfu-systems/kungfu',
      releaseBaseUrl: `https://github.com/kungfu-systems/kungfu/releases/download/${releaseTag}`,
      manifestAsset: 'kungfu-installer-publication-bundle.json',
    },
  };
  const expected = {
    bundle,
    version: '4.0.0-alpha.1',
    candidateSourceSha,
    releaseSha,
    releaseTag,
  };
  assert.equal(validateExistingPublicationIdentity(expected), bundle);
  assert.equal(
    validateExistingPublicationIdentity({
      ...expected,
      acceptedSourceShas: [candidateSourceSha, builtSourceSha],
      bundle: {
        ...bundle,
        identity: { ...bundle.identity, sourceCommit: builtSourceSha },
      },
    }).identity.sourceCommit,
    builtSourceSha,
  );
  assert.throws(
    () =>
      validateExistingPublicationIdentity({
        ...expected,
        candidateSourceSha: '3'.repeat(40),
      }),
    /does not match the exact Alpha release identity/u,
  );
  assert.throws(
    () =>
      validateExistingPublicationIdentity({
        ...expected,
        bundle: {
          ...bundle,
          identity: { ...bundle.identity, releaseSha: '4'.repeat(40) },
        },
      }),
    /does not match the exact Alpha release identity/u,
  );
});

test('release asset reconciliation reuses only the exact uploaded winner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-release-winner-'));
  try {
    const file = path.join(root, 'bundle.json');
    fs.writeFileSync(file, 'exact-publication-bytes');
    const winner = {
      name: 'bundle.json',
      state: 'uploaded',
      size: fs.statSync(file).size,
      digest: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`,
    };
    assert.equal(existingReleaseAssetIsWinner(undefined, file), false);
    assert.equal(existingReleaseAssetIsWinner(winner, file), true);
    assert.throws(
      () =>
        existingReleaseAssetIsWinner(
          { ...winner, size: winner.size + 1 },
          file,
        ),
      /conflicts with existing bytes/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publication signing identity is derived from Ed25519 public bytes', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const identity = signingIdentity(
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  assert.match(identity.keyId, /^ed25519-[a-f0-9]{16}$/);
  assert.equal(Buffer.from(identity.publicKey, 'base64').length, 32);
});

test('publication evidence binds exact read-back and rollback authority', () => {
  const bundleRoot = `sha256:${'c'.repeat(64)}`;
  const evidence = publicationCommitEvidence({
    version: '4.0.0-alpha.2',
    sourceSha: '2'.repeat(40),
    candidateSourceSha: '1'.repeat(40),
    releaseSha: '2'.repeat(40),
    releaseTag: 'v4.0.0-alpha.2',
    payloadRoot: `sha256:${'a'.repeat(64)}`,
    previousPayloadRoot: `sha256:${'b'.repeat(64)}`,
    bundle: {
      schema: 'kungfu.installer-publication-bundle/v1',
      bundleRoot,
      distribution: {
        releaseBaseUrl:
          'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.2',
        manifestAsset: 'kungfu-installer-publication-bundle.json',
      },
      identity: {
        sourceCommit: '1'.repeat(40),
        channel: 'alpha',
        releasePassport: {
          ref: 'buildchain:release-passport/fixture',
          root: `sha256:${'d'.repeat(64)}`,
        },
      },
      cachePolicy: {
        friendly: 'public,max-age=300,must-revalidate',
        immutable: 'public,max-age=31536000,immutable',
      },
      assets: [],
    },
    readbackDigest: `sha256:${'e'.repeat(64)}`,
  });
  assert.equal(evidence.readback.status, 'passed');
  assert.equal(evidence.identity.sourceSha, '2'.repeat(40));
  assert.equal(evidence.identity.candidateSourceSha, '1'.repeat(40));
  assert.equal(evidence.readback.payloadRoot, evidence.publication.payloadRoot);
  assert.equal(evidence.publication.payloadRoot, bundleRoot);
  assert.equal(
    evidence.publication.installerBundle.cachePolicy.immutable,
    'public,max-age=31536000,immutable',
  );
  assert.equal(evidence.siteHandoff.productionAvailable, false);
  assert.equal(evidence.recovery.previousAuthority, 'preserved');
  assert.equal(evidence.recovery.rollbackReference, `sha256:${'b'.repeat(64)}`);
});

test('channel timestamp is deterministically owned by the final passport', () => {
  assert.equal(
    publicationTimestamp({
      surfaceTimestampPolicy: {
        publishedAt: '2026-07-24T06:00:00.000Z',
      },
    }).toISOString(),
    '2026-07-24T06:00:00.000Z',
  );
  assert.throws(
    () => publicationTimestamp({}),
    /publication timestamp is required/,
  );
});

test('publication commit owns Kungfu release assets but no site repository operation', () => {
  const source = fs.readFileSync(
    new URL('./alpha-publication-commit.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /gh[\s\S]*release[\s\S]*upload/);
  assert.doesNotMatch(
    source,
    /site-kungfu-tech|SITE_REPOSITORY|sitePullRequest|repo['"]?,\s*['"]clone/,
  );
  assert.ok(
    source.indexOf('verifyAlphaPublicationTailPlan({') <
      source.indexOf('await previousAuthority('),
    'the source-bound tail plan must fail closed before public side effects',
  );
});

test('sealed-candidate recovery preserves the resolved artifact source for the publication tail', () => {
  const source = fs.readFileSync(
    new URL('./alpha-publication-commit.mjs', import.meta.url),
    'utf8',
  );
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/release-new-version.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /candidateSourceSha:[\s\S]*BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA[\s\S]*\|\|[\s\S]*BUILDCHAIN_PUBLICATION_COMMIT_SOURCE_SHA/u,
  );
  assert.match(
    workflow,
    /publication-commit-command: BUILDCHAIN_PUBLICATION_COMMIT_PRODUCT_ROOT=\$GITHUB_WORKSPACE node \.buildchain\/publication-controller\/scripts\/alpha-publication-commit\.mjs/u,
  );
  assert.doesNotMatch(
    workflow,
    /publication-commit-command:.*BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA=/u,
  );
  assert.match(source, /root: PRODUCT_ROOT,[\s\S]*expectedSourceCommit:/u);
  assert.match(source, /expectedSourceSha: sourceSha/u);
  assert.match(
    source,
    /bindProductReleaseCut\(entry\.manifest,[\s\S]*sourceBuild: false/u,
  );
  assert.match(
    workflow,
    /publication-commit-command: \$\{\{ startsWith\([\s\S]*'node scripts\/alpha-publication-commit\.mjs' \|\| '' \}\}/u,
  );
});

test('publication commit reuses an immutable existing launcher component Release', () => {
  assert.equal(
    validateExistingLauncherRelease({
      tag: 'shifu-v4.0.0-alpha.1',
      release: {
        tagName: 'shifu-v4.0.0-alpha.1',
        assets: [
          { name: 'component-release-bom.json' },
          { name: 'SHA256SUMS' },
          { name: 'shifu-linux-x64' },
        ],
      },
    }),
    'shifu-v4.0.0-alpha.1',
  );
  assert.throws(
    () =>
      validateExistingLauncherRelease({
        tag: 'shifu-v4.0.0-alpha.1',
        release: {
          tagName: 'shifu-v4.0.0-alpha.1',
          assets: [{ name: 'component-release-bom.json' }],
        },
      }),
    /missing SHA256SUMS/u,
  );
});
