// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublishedReleaseManifestResolver,
  publishedManifestAssetName,
} from './release-manifest-resolver';

const version = '4.0.0-alpha.1';
const manifest = {
  schema: 'kungfu.product-upgrade.manifest/v1' as const,
  productVersion: version,
  runtimeBuildId: 'runtime-a',
  documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
  platform: 'darwin',
  architecture: 'arm64',
  sourceCommit: '1'.repeat(40),
  qualificationEvidenceRef: 'buildchain:qualification/run-1',
  artifacts: [
    {
      kind: 'runtime',
      url: 'app-resource://kungfu',
      signature: 'sigstore:runtime',
    },
    {
      kind: 'desktop',
      url: 'https://github.com/kungfu-systems/kungfu/releases/download/test/app.zip',
      signature: 'apple:notarization-ticket',
    },
  ],
};

test('published manifest resolver binds updater version and platform', async () => {
  const requested: string[] = [];
  const resolve = createPublishedReleaseManifestResolver({
    platform: 'darwin',
    architecture: 'arm64',
    releaseBaseUrl:
      'https://github.com/kungfu-systems/kungfu/releases/download/',
    async fetch(url) {
      requested.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => '512' },
        async text() {
          return JSON.stringify(manifest);
        },
      };
    },
  });

  assert.deepEqual(await resolve({ version }), manifest);
  assert.equal(
    requested[0],
    `https://github.com/kungfu-systems/kungfu/releases/download/v${version}/${publishedManifestAssetName(version, 'darwin', 'arm64')}`,
  );
});

test('unqualified remote manifests fail closed before download', async () => {
  const resolve = createPublishedReleaseManifestResolver({
    platform: 'darwin',
    architecture: 'arm64',
    releaseBaseUrl: 'https://example.invalid/releases',
    async fetch() {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify({
            ...manifest,
            qualificationEvidenceRef: 'unqualified-local-build:fixture',
          });
        },
      };
    },
  });

  await assert.rejects(resolve({ version }), /is not qualified/);
});

test('manifest resolver rejects a cross-platform release identity', async () => {
  const resolve = createPublishedReleaseManifestResolver({
    platform: 'win32',
    architecture: 'x64',
    releaseBaseUrl: 'https://example.invalid/releases',
    async fetch() {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify(manifest);
        },
      };
    },
  });

  await assert.rejects(resolve({ version }), /does not match updater/);
});
