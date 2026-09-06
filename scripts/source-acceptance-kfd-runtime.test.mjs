// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkColdBuildchainKfd,
  loadBuildchainKfdRuntime,
  resolveGitBoundKfdEvidenceSourceSha,
} from '../product/release/buildchain-kfd-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('KFD evidence runtime adapts the repository-bound Git reader for queue replay', () => {
  const sourceSha = 'a'.repeat(40);
  const resolved = resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write: false,
    committed: sourceSha,
    configured: sourceSha,
    prepareHistory: () => {},
    selectSourceSha: () => sourceSha,
    assertBinding: ({
      sourceSha: selectedSourceSha,
      headSha,
      findTreeEquivalentAncestor,
    }) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.equal(
        findTreeEquivalentAncestor(selectedSourceSha, headSha),
        'c'.repeat(40),
      );
      return selectedSourceSha;
    },
    findTreeEquivalentAncestor: (selectedSourceSha, headSha, gitRead) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.match(headSha, /^[0-9a-f]{40}$/u);
      assert.equal(typeof gitRead, 'function');
      assert.equal(gitRead(['rev-parse', 'HEAD']), headSha);
      return 'c'.repeat(40);
    },
  });
  assert.equal(resolved, sourceSha);
});

test('KFD evidence runtime hydrates a recovered write source before binding', () => {
  const sourceSha = 'a'.repeat(40);
  let prepared = false;
  const resolved = resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write: true,
    committed: '',
    configured: sourceSha,
    prepareHistory: (root, options) => {
      assert.equal(root, ROOT);
      assert.deepEqual(options, { requiredCommit: sourceSha });
      prepared = true;
    },
    selectSourceSha: ({ write, configured }) => {
      assert.equal(write, true);
      assert.equal(configured, sourceSha);
      return sourceSha;
    },
    assertBinding: ({ sourceSha: selectedSourceSha, headSha }) => {
      assert.equal(prepared, true);
      assert.equal(selectedSourceSha, sourceSha);
      assert.match(headSha, /^[0-9a-f]{40}$/u);
      return selectedSourceSha;
    },
    findTreeEquivalentAncestor: () => '',
  });
  assert.equal(resolved, sourceSha);
});

test('adopter manifests use the release verifier KFD package cut', async () => {
  const { adopter } = await loadBuildchainKfdRuntime();
  const packageArtifactRoot = adopter.installedKfdPackageArtifactRoot();
  const manifest = adopter.initAdopterManifest({
    manifestId: 'kungfu-release-cut-test',
    adopterId: 'kungfu-systems/kungfu',
    artifactKind: 'git-commit',
    artifactCoordinate: `kungfu-systems/kungfu@${'a'.repeat(40)}`,
    artifactRoot: `sha256:${'b'.repeat(64)}`,
    scope: 'Release verifier package-cut integration',
    packageArtifactRoot,
    verifiedAt: '2026-09-06T00:00:00Z',
    maxAgeSeconds: 86400,
  });
  const options = {
    manifest,
    packageArtifactRoot,
    expectedAdopterId: 'kungfu-systems/kungfu',
    expectedSourceRepository: 'kungfu-systems/kungfu',
    checkedAt: '2026-09-06T00:00:00Z',
  };
  const gate = adopter.createKfdAdopterManifestGate(options);
  assert.equal(manifest.kfdCut.package.version, gate.standardPackage.version);
  assert.equal(
    gate.issues.some(({ code }) => code === 'adopter-package-cut'),
    false,
  );
  manifest.kfdCut.package.version = '0.0.0-stale';
  const stale = adopter.createKfdAdopterManifestGate(options);
  assert.equal(
    stale.issues.some(({ code }) => code === 'adopter-package-cut'),
    true,
  );
});

test('cold KFD evidence binds the governed v4 Alpha contract lock', () => {
  const result = checkColdBuildchainKfd(ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cold-source-check');
  assert.equal(result.contractLock, '.buildchain/alpha-contract-lock.json');
});
