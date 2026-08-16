// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  finalizeMacosReleaseArtifacts,
  macosReleaseFinalizationReceiptRoot,
} from './upgrade-manifest.mjs';

const SCRIPT = fileURLToPath(
  new URL('./upgrade-manifest.mjs', import.meta.url),
);
const SOURCE_SHA = '1'.repeat(40);
const SOURCE_TREE_SHA = '2'.repeat(40);
const RUNTIME_SHA = '3'.repeat(40);
const REQUEST_DIGEST = `sha256:${'4'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'5'.repeat(64)}`;
const VERSION = '4.0.0-alpha.2';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function json(root, relative, value) {
  return write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function signingFixture({ updateMetadata = 'latest-mac.yml' } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-macos-release-finalization-'),
  );
  const finalArtifacts = [
    {
      path: `product/release/Kungfu-Episodes-${VERSION}-macos-arm64.dmg`,
      bytes: Buffer.from('signed-and-notarized-dmg'),
    },
    {
      path: `product/release/Kungfu-Episodes-${VERSION}-macos-arm64.zip`,
      bytes: Buffer.from('signed-and-notarized-updater-zip'),
    },
  ];
  for (const artifact of finalArtifacts)
    write(root, artifact.path, artifact.bytes);

  const intermediateArtifacts = [
    {
      path: `product/release/desktop/Kungfu Episodes-${VERSION}-arm64.dmg`,
      bytes: Buffer.from('electron-builder-dmg'),
    },
    {
      path: `product/release/desktop/Kungfu Episodes-${VERSION}-arm64.dmg.blockmap`,
      bytes: Buffer.from('dmg-blockmap'),
    },
    {
      path: `product/release/desktop/Kungfu Episodes-${VERSION}-arm64-mac.zip`,
      bytes: Buffer.from('electron-builder-zip'),
    },
    {
      path: `product/release/desktop/Kungfu Episodes-${VERSION}-arm64-mac.zip.blockmap`,
      bytes: Buffer.from('zip-blockmap'),
    },
  ];
  for (const artifact of intermediateArtifacts)
    write(root, artifact.path, artifact.bytes);
  write(
    root,
    `product/release/desktop/${updateMetadata}`,
    'version: 4.0.0-alpha.2\npath: retained-updater.zip\n',
  );
  json(root, 'product/release/desktop/update-info.json', { retained: true });

  const manifest = {
    contract: 'kungfu-buildchain-artifact',
    lifecycle: { stage: 'credential-island', executed: true },
    platform: { id: 'macos-arm64-credential' },
    git: { sha: SOURCE_SHA },
    expectedArtifacts: { ok: true },
    files: finalArtifacts.map((artifact) => ({
      path: artifact.path,
      size: artifact.bytes.length,
      sha256: sha256(artifact.bytes),
    })),
  };
  const manifestFile = json(
    root,
    '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/credential-artifact/manifest.json',
    manifest,
  );
  const manifestDigest = `sha256:${sha256(fs.readFileSync(manifestFile))}`;
  const evidence = [
    {
      kind: 'credential-artifact-manifest',
      path: 'credential-artifact/manifest.json',
      digest: manifestDigest,
    },
    ...finalArtifacts.map((artifact) => ({
      kind: 'credential-artifact',
      path: `credential-artifact/${artifact.path}`,
      digest: `sha256:${sha256(artifact.bytes)}`,
    })),
  ];
  json(
    root,
    '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/result.json',
    {
      contract: 'kungfu-buildchain-artifact-signing-result/v1',
      requestDigest: REQUEST_DIGEST,
      source: { sha: SOURCE_SHA },
      evidence,
      evidenceDigest: EVIDENCE_DIGEST,
      verification: { status: 'passed' },
    },
  );
  json(
    root,
    '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/receipt.json',
    {
      contract: 'kungfu-buildchain-artifact-signing-receipt/v1',
      requestDigest: REQUEST_DIGEST,
      status: 'passed',
      result: { evidenceDigest: EVIDENCE_DIGEST },
    },
  );
  return { root, finalArtifacts, intermediateArtifacts };
}

function options(root) {
  return {
    workspace: root,
    sourceSha: SOURCE_SHA,
    sourceTreeSha: SOURCE_TREE_SHA,
    runtimeSha: RUNTIME_SHA,
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('CLI defaults prune only redundant archives after signed authority verification', () => {
  const fixture = signingFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'finalize-macos-release-artifacts'],
      {
        cwd: fixture.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BUILDCHAIN_SOURCE_SHA: SOURCE_SHA,
          BUILDCHAIN_SOURCE_TREE_SHA: SOURCE_TREE_SHA,
          BUILDCHAIN_RUNTIME_SHA: RUNTIME_SHA,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.reused, false);
    for (const artifact of fixture.finalArtifacts)
      assert.equal(
        fs
          .readFileSync(path.join(fixture.root, artifact.path))
          .compare(artifact.bytes),
        0,
      );
    for (const artifact of fixture.intermediateArtifacts)
      assert.equal(
        fs.existsSync(path.join(fixture.root, artifact.path)),
        false,
      );
    assert.equal(
      fs.existsSync(
        path.join(fixture.root, 'product/release/desktop/latest-mac.yml'),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.root, 'product/release/desktop/update-info.json'),
      ),
      true,
    );
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.root,
          'product/release/qualification/macos-release-artifact-finalization.json',
        ),
        'utf8',
      ),
    );
    assert.equal(
      receipt.receiptRoot,
      macosReleaseFinalizationReceiptRoot(receipt),
    );
    assert.equal(receipt.retained.length, 2);
    assert.equal(receipt.removed.length, 4);
    assert.equal(
      receipt.removedTotalBytes,
      fixture.intermediateArtifacts.reduce(
        (total, artifact) => total + artifact.bytes.length,
        0,
      ),
    );
  } finally {
    cleanup(fixture);
  }
});

test('finalization is idempotent for the same signed source and artifact bytes', async () => {
  const fixture = signingFixture();
  try {
    const first = await finalizeMacosReleaseArtifacts(options(fixture.root));
    const receiptBytes = fs.readFileSync(first.receiptFile);
    const second = await finalizeMacosReleaseArtifacts(options(fixture.root));
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.receipt.receiptRoot, first.receipt.receiptRoot);
    assert.equal(fs.readFileSync(first.receiptFile).compare(receiptBytes), 0);
  } finally {
    cleanup(fixture);
  }
});

test('finalization preserves Alpha channel macOS update metadata', async () => {
  const fixture = signingFixture({ updateMetadata: 'alpha-mac.yml' });
  try {
    const result = await finalizeMacosReleaseArtifacts(options(fixture.root));
    assert.equal(result.reused, false);
    assert.ok(
      result.receipt.preservedMetadata.some(
        ({ path: retainedPath }) =>
          retainedPath === 'product/release/desktop/alpha-mac.yml',
      ),
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.root, 'product/release/desktop/alpha-mac.yml'),
      ),
      true,
    );
  } finally {
    cleanup(fixture);
  }
});

test('finalization rejects missing or ambiguous macOS update metadata before deletion', async () => {
  for (const variant of ['missing', 'ambiguous']) {
    const fixture = signingFixture();
    try {
      if (variant === 'missing')
        fs.rmSync(
          path.join(fixture.root, 'product/release/desktop/latest-mac.yml'),
        );
      else
        write(
          fixture.root,
          'product/release/desktop/alpha-mac.yml',
          'version: 4.0.0-alpha.2\npath: retained-updater.zip\n',
        );
      await assert.rejects(
        finalizeMacosReleaseArtifacts(options(fixture.root)),
        /expected one electron-builder macOS update metadata file/u,
      );
      for (const artifact of fixture.intermediateArtifacts)
        assert.equal(
          fs.existsSync(path.join(fixture.root, artifact.path)),
          true,
        );
    } finally {
      cleanup(fixture);
    }
  }
});

test('finalization fails closed before deletion when signing source does not match', async () => {
  const fixture = signingFixture();
  try {
    await assert.rejects(
      finalizeMacosReleaseArtifacts({
        ...options(fixture.root),
        sourceSha: '9'.repeat(40),
      }),
      /credential manifest is not the accepted macOS credential-island output/u,
    );
    for (const artifact of fixture.intermediateArtifacts)
      assert.equal(fs.existsSync(path.join(fixture.root, artifact.path)), true);
  } finally {
    cleanup(fixture);
  }
});

test('finalization rejects ambiguous electron-builder archives', async () => {
  const fixture = signingFixture();
  try {
    write(
      fixture.root,
      `product/release/desktop/Kungfu Episodes-${VERSION}-second-arm64.dmg`,
      'unexpected-second-dmg',
    );
    await assert.rejects(
      finalizeMacosReleaseArtifacts(options(fixture.root)),
      /expected one electron-builder DMG and ZIP/u,
    );
    for (const artifact of fixture.intermediateArtifacts)
      assert.equal(fs.existsSync(path.join(fixture.root, artifact.path)), true);
  } finally {
    cleanup(fixture);
  }
});

test('known alpha artifact savings are exact and keep canonical DMG and ZIP', () => {
  const removedBytes = [265_287_726, 266_837_316, 276_225, 263_688];
  assert.equal(
    removedBytes.reduce((total, size) => total + size, 0),
    532_664_955,
  );
  assert.equal(1_365_557_225 - 532_664_955, 832_892_270);
});
