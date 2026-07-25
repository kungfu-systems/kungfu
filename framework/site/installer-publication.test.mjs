// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INSTALLER_PUBLICATION_BUNDLE_SCHEMA,
  verifyInstallerPublicationBundle,
  writeInstallerPublicationBundle,
} from './installer-publication.mjs';

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-installer-publication-bundle-'),
  );
  const source = path.join(root, 'publication');
  const immutablePath = `installers/v1/alpha/4.0.0-alpha.1/${'1'.repeat(64)}`;
  fs.mkdirSync(path.join(source, immutablePath), { recursive: true });
  const scripts = new Map([
    ['install.sh', Buffer.from('#!/bin/sh\nexit 0\n')],
    ['install.ps1', Buffer.from('exit 0\r\n')],
  ]);
  const assets = [];
  for (const [name, bytes] of scripts) {
    fs.writeFileSync(path.join(source, name), bytes);
    fs.writeFileSync(path.join(source, immutablePath, name), bytes);
    assets.push({
      name,
      contentType:
        name === 'install.sh'
          ? 'text/x-shellscript; charset=utf-8'
          : 'text/plain; charset=utf-8',
      size: bytes.length,
      digest: digest(bytes),
      friendlyUrl: `https://kungfu.tech/${name}`,
      immutableUrl: `https://kungfu.tech/${immutablePath}/${name}`,
    });
  }
  const channel = {
    schema: 'kungfu.release-channel-index/v1',
    payloadRoot: `sha256:${'1'.repeat(64)}`,
  };
  const channelBytes = Buffer.from(`${JSON.stringify(channel)}\n`);
  const channelIndexPath = path.join(root, 'alpha.json');
  const trustedKeysPath = path.join(root, 'trusted-keys.json');
  fs.writeFileSync(channelIndexPath, channelBytes);
  fs.writeFileSync(
    trustedKeysPath,
    `${JSON.stringify([{ keyId: 'fixture', publicKey: `${'A'.repeat(43)}=` }])}\n`,
  );
  const publication = {
    schema: 'kungfu.bootstrap-installer-publication/v1',
    installerVersion: 'v1',
    channel: 'alpha',
    sourceCommit: 'a'.repeat(40),
    channelPayloadRoot: channel.payloadRoot,
    channelFileDigest: digest(channelBytes),
    releasePassport: {
      ref: 'buildchain:release-passport/fixture',
      root: `sha256:${'2'.repeat(64)}`,
    },
    immutablePath,
    entries: [{ version: '4.0.0-alpha.1' }],
    assets,
  };
  fs.writeFileSync(
    path.join(source, 'installer-publication.json'),
    `${JSON.stringify(publication, null, 2)}\n`,
  );
  return {
    root,
    source,
    channelIndexPath,
    trustedKeysPath,
    output: path.join(root, 'bundle'),
  };
}

test('writes one closed-world package-owned installer publication bundle', () => {
  const value = fixture();
  try {
    const bundle = writeInstallerPublicationBundle({
      publicationRoot: value.source,
      channelIndexPath: value.channelIndexPath,
      trustedKeysPath: value.trustedKeysPath,
      outputRoot: value.output,
      packageVersion: '4.0.0-alpha.1',
      releaseSha: 'b'.repeat(40),
      releaseTag: 'v4.0.0-alpha.1',
    });
    assert.equal(bundle.schema, INSTALLER_PUBLICATION_BUNDLE_SCHEMA);
    assert.match(bundle.bundleRoot, /^sha256:[a-f0-9]{64}$/);
    assert.equal(bundle.assets.length, 7);
    assert.equal(
      verifyInstallerPublicationBundle({
        bundleRoot: value.output,
        expectedBundleRoot: bundle.bundleRoot,
      }).bundleRoot,
      bundle.bundleRoot,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects byte drift, extra files, and symlinks', () => {
  const value = fixture();
  try {
    writeInstallerPublicationBundle({
      publicationRoot: value.source,
      channelIndexPath: value.channelIndexPath,
      trustedKeysPath: value.trustedKeysPath,
      outputRoot: value.output,
      packageVersion: '4.0.0-alpha.1',
      releaseSha: 'b'.repeat(40),
      releaseTag: 'v4.0.0-alpha.1',
    });
    fs.writeFileSync(path.join(value.output, 'install.sh'), 'tampered\n');
    assert.throws(
      () => verifyInstallerPublicationBundle({ bundleRoot: value.output }),
      /metadata drifted|bytes differ/,
    );
    fs.copyFileSync(
      path.join(value.source, 'install.sh'),
      path.join(value.output, 'install.sh'),
    );
    fs.writeFileSync(path.join(value.output, 'extra.txt'), 'extra\n');
    assert.throws(
      () => verifyInstallerPublicationBundle({ bundleRoot: value.output }),
      /closed-world|content type/,
    );
    fs.rmSync(path.join(value.output, 'extra.txt'));
    fs.symlinkSync('install.sh', path.join(value.output, 'linked.sh'));
    assert.throws(
      () => verifyInstallerPublicationBundle({ bundleRoot: value.output }),
      /symlink/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
