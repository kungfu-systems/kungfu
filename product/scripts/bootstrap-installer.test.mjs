// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  BOOTSTRAP_PUBLICATION_SCHEMA,
  buildBootstrapInstallerPublication,
} from './bootstrap-installer.mjs';
import { buildChannelIndex } from './release-channel-index.mjs';
import { INTEL_MACOS_DIAGNOSTIC } from './runtime-pin-snapshot.mjs';
import { bindProductReleaseCut } from './upgrade-manifest.mjs';

function fixture(
  targets = [
    ['darwin', 'arm64', 'tar.gz'],
    ['linux', 'x64', 'tar.gz'],
    ['win32', 'x64', 'zip'],
  ],
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-bootstrap-installer-'),
  );
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'kungfu-alpha-fixture-1';
  const rawPublicKey = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
  const sourceCommit = 'a'.repeat(40);
  const entries = targets.map(([platform, architecture, extension]) => {
    const manifestPath = path.join(root, `${platform}-${architecture}.json`);
    const manifest = bindProductReleaseCut({
      schema: 'kungfu.product-upgrade.manifest/v1',
      productVersion: '4.0.0-alpha.1',
      releaseChannel: 'alpha',
      sourceCommit,
      runtimeBuildId: `runtime-${platform}-${architecture}`,
      runtimeArtifactDigest: `sha256:${'1'.repeat(64)}`,
      runtimeEntrypoint: platform === 'win32' ? 'kungfu.exe' : 'kungfu',
      frontendBuildId: 'product-fixture',
      controlProtocolRange: { min: 1, max: 1 },
      peerWireProtocolRange: { min: 1, max: 1 },
      journalSchemaReadRange: { min: 1, max: 1 },
      journalSchemaWriteVersion: 1,
      migrationClass: 'none',
      rollbackClass: 'automatic',
      minimumSupportedFrontend: '4.0.0-alpha.0',
      minimumSupportedRuntime: '4.0.0-alpha.0',
      platform,
      architecture,
      artifacts: [
        {
          kind: 'runtime',
          url: 'app-resource://kungfu',
          size: 1,
          digest: `sha256:${'1'.repeat(64)}`,
          signature: 'fixture-runtime-signature',
        },
        {
          kind: 'cli',
          url: `https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-cli-${platform}-${architecture}.${extension}`,
          size: 4096,
          digest: `sha256:${'2'.repeat(64)}`,
          signature: `fixture-${platform}-signature`,
        },
      ],
      qualificationEvidenceRef: 'buildchain:fixture/qualified',
      documentationUrl: 'https://kungfu.tech/install/',
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    return {
      channel: 'alpha',
      installSource: 'archive',
      rollout: 'current',
      manifestPath,
      documentationUrl: 'https://kungfu.tech/install/',
    };
  });
  const index = buildChannelIndex({
    spec: {
      keyId,
      generatedAt: '2026-07-24T00:00:00Z',
      expiresAt: '2026-08-24T00:00:00Z',
      sourceCommit,
      releasePassport: {
        ref: `buildchain:release-candidate-passport/${sourceCommit}`,
        root: `sha256:${'3'.repeat(64)}`,
      },
      entries,
    },
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    baseDirectory: root,
  });
  return {
    root,
    index,
    trustedKeys: { [keyId]: rawPublicKey },
  };
}

test('bootstrap publication rejects Intel macOS before emitting installers', () => {
  const value = fixture([['darwin', 'x64', 'tar.gz']]);
  try {
    assert.throws(
      () =>
        buildBootstrapInstallerPublication({
          channelIndex: value.index,
          trustedKeys: value.trustedKeys,
          channel: 'alpha',
          channelUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
        }),
      (error) => {
        assert.equal(error.message, INTEL_MACOS_DIAGNOSTIC);
        return true;
      },
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('bootstrap publication is deterministic and pins signed release identity', () => {
  const value = fixture();
  try {
    const options = {
      channelIndex: value.index,
      trustedKeys: value.trustedKeys,
      channel: 'alpha',
      channelUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
    };
    const first = buildBootstrapInstallerPublication(options);
    const second = buildBootstrapInstallerPublication(options);
    assert.equal(first.schema, BOOTSTRAP_PUBLICATION_SCHEMA);
    assert.equal(first.channelPayloadRoot, value.index.payloadRoot);
    assert.deepEqual(
      first.entries.map((entry) => `${entry.platform}/${entry.architecture}`),
      ['darwin/arm64', 'linux/x64', 'win32/x64'],
    );
    for (const entry of first.entries) {
      assert.match(entry.releaseCutRoot, /^sha256:[a-f0-9]{64}$/);
      assert.match(entry.platformSliceRoot, /^sha256:[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      first.assets.map(({ bytes: _bytes, ...asset }) => asset),
      second.assets.map(({ bytes: _bytes, ...asset }) => asset),
    );
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(
          'framework/upgrade/kungfu-bootstrap-installer.schema.json',
        ),
        'utf8',
      ),
    );
    const validate = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(schema);
    assert.equal(
      validate({
        ...first,
        assets: first.assets.map(({ bytes: _bytes, ...asset }) => asset),
      }),
      true,
      JSON.stringify(validate.errors),
    );
    for (const asset of first.assets) {
      assert.match(
        asset.immutableUrl,
        new RegExp(
          `/installers/v1/alpha/4\\.0\\.0-alpha\\.1/${value.index.payloadRoot.slice(7)}/`,
        ),
      );
      assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    }
    const shell = first.assets.find((asset) => asset.name === 'install.sh');
    assert.equal(
      first.channelSnapshotUrl,
      `https://kungfu.tech/channels/alpha/${value.index.payloadRoot.slice(7)}/index.json`,
    );
    assert.match(
      shell.bytes.toString(),
      new RegExp(
        `/channels/alpha/${value.index.payloadRoot.slice(7)}/index\\.json`,
      ),
    );
    assert.match(shell.bytes.toString(), /update bootstrap-verify/);
    assert.match(shell.bytes.toString(), /release_cut_root='sha256:/);
    assert.match(shell.bytes.toString(), /platform_slice_root='sha256:/);
    assert.match(shell.bytes.toString(), /channel-byte-mismatch/);
    assert.match(shell.bytes.toString(), /ownership-conflict/);
    assert.match(shell.bytes.toString(), /--dry-run/);
    assert.match(shell.bytes.toString(), /sha256sum/);
    assert.match(shell.bytes.toString(), /archive-unsafe/);
    assert.match(
      shell.bytes.toString(),
      /export KUNGFU_INSTALL_SOURCE=archive/,
    );
    assert.match(
      shell.bytes.toString(),
      /export KUNGFU_DIR="\$version_root\/runtime"/,
    );
    assert.match(
      shell.bytes.toString(),
      /ln -s "\$version_root\/install\/kungfu-archive-launcher"/,
    );
    assert.ok(
      shell.bytes.toString().indexOf('export KUNGFU_INSTALL_SOURCE=archive') <
        shell.bytes.toString().indexOf('exec "$version_root/kungfu" "$@"'),
    );
    assert.equal(shell.bytes.toString().includes(INTEL_MACOS_DIAGNOSTIC), true);
    const shellPath = path.join(value.root, 'install.sh');
    fs.writeFileSync(shellPath, shell.bytes);
    const syntax = spawnSync('/bin/sh', ['-n', shellPath], {
      encoding: 'utf8',
    });
    assert.equal(syntax.status, 0, syntax.stderr);
    const shellcheck = spawnSync('shellcheck', ['-s', 'sh', shellPath], {
      encoding: 'utf8',
    });
    if (!shellcheck.error || shellcheck.error.code !== 'ENOENT') {
      assert.equal(shellcheck.status, 0, shellcheck.stdout + shellcheck.stderr);
    }
    const installedLauncher = shell.bytes
      .toString()
      .match(
        /<<'KUNGFU_ARCHIVE_LAUNCHER'\n([\s\S]+?)\nKUNGFU_ARCHIVE_LAUNCHER/,
      )?.[1];
    assert.ok(installedLauncher);
    const installedRoot = path.join(value.root, 'installed product');
    const installedBin = path.join(value.root, 'bin');
    fs.mkdirSync(path.join(installedRoot, 'install'), { recursive: true });
    fs.mkdirSync(installedBin, { recursive: true });
    const installedLauncherPath = path.join(
      installedRoot,
      'install',
      'kungfu-archive-launcher',
    );
    fs.writeFileSync(installedLauncherPath, `${installedLauncher}\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(installedRoot, 'kungfu'),
      '#!/bin/sh\nprintf \'%s\\n\' "$KUNGFU_INSTALL_SOURCE" "$KUNGFU_DIR" "$1"\n',
      { mode: 0o755 },
    );
    const installedEntrypoint = path.join(installedBin, 'kungfu');
    fs.symlinkSync(installedLauncherPath, installedEntrypoint);
    const installedInvocation = spawnSync(installedEntrypoint, ['probe'], {
      encoding: 'utf8',
    });
    assert.equal(installedInvocation.status, 0, installedInvocation.stderr);
    assert.deepEqual(installedInvocation.stdout.trim().split('\n'), [
      'archive',
      path.join(installedRoot, 'runtime'),
      'probe',
    ]);

    const powershell = first.assets.find(
      (asset) => asset.name === 'install.ps1',
    );
    assert.doesNotMatch(
      powershell.bytes.toString(),
      /Get-AuthenticodeSignature/,
    );
    assert.match(powershell.bytes.toString(), /signed-channel-digest/);
    assert.match(
      powershell.bytes.toString(),
      /existing Kungfu is owned outside \$\{Launcher\}:/,
    );
    assert.match(powershell.bytes.toString(), /update bootstrap-verify/);
    assert.match(powershell.bytes.toString(), /\$ReleaseCutRoot = 'sha256:/);
    assert.match(powershell.bytes.toString(), /\$PlatformSliceRoot = 'sha256:/);
    assert.match(powershell.bytes.toString(), /PATH, profiles, registry/);
    assert.match(powershell.bytes.toString(), /RequestedVersion/);
    assert.match(powershell.bytes.toString(), /KUNGFU_INSTALL_SOURCE=archive/);
    assert.match(
      powershell.bytes.toString(),
      /KUNGFU_DIR=\$VersionRoot\\runtime/,
    );
    assert.ok(
      powershell.bytes.toString().indexOf('KUNGFU_INSTALL_SOURCE=archive') <
        powershell.bytes.toString().indexOf('@call'),
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('bootstrap publication rejects tampered channel authority', () => {
  const value = fixture();
  try {
    value.index.sourceCommit = 'b'.repeat(40);
    assert.throws(
      () =>
        buildBootstrapInstallerPublication({
          channelIndex: value.index,
          trustedKeys: value.trustedKeys,
          channel: 'alpha',
          channelUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
        }),
      /payload root mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('bootstrap publication rejects unqualified CLI signing evidence', () => {
  const value = fixture();
  try {
    value.index.entries[0].manifest.artifacts.find(
      (artifact) => artifact.kind === 'cli',
    ).signature = 'unqualified-local-build';
    assert.throws(
      () =>
        buildBootstrapInstallerPublication({
          channelIndex: value.index,
          trustedKeys: value.trustedKeys,
          channel: 'alpha',
          channelUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
        }),
      /signature|payload root|publication-qualified/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
