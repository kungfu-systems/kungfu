// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractTarGz, extractZip, writeTarGz, writeZip } from './archive.mjs';

function makeFixture(parent) {
  const sourceDir = path.join(parent, 'source');
  const productRoot = path.join(sourceDir, 'kungfu-cli-test');
  const bin = path.join(productRoot, 'kungfu', 'kungfu');
  const longPath = path.join(
    productRoot,
    'extensions',
    'system',
    'skill-manager',
    'dist',
    'view',
    'index.js',
  );
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.dirname(longPath), { recursive: true });
  fs.writeFileSync(
    path.join(productRoot, 'product.json'),
    '{"schema":"kungfu.product.cli/v1"}\n',
  );
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  fs.writeFileSync(longPath, 'export default "ok";\n');
  fs.chmodSync(bin, 0o755);
  return { sourceDir, productRoot };
}

function assertExtracted(targetDir) {
  const productRoot = path.join(targetDir, 'kungfu-cli-test');
  assert.equal(
    fs.readFileSync(path.join(productRoot, 'product.json'), 'utf8'),
    '{"schema":"kungfu.product.cli/v1"}\n',
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        productRoot,
        'extensions',
        'system',
        'skill-manager',
        'dist',
        'view',
        'index.js',
      ),
      'utf8',
    ),
    'export default "ok";\n',
  );
  assert.equal(
    fs.readFileSync(path.join(productRoot, 'kungfu', 'kungfu'), 'utf8'),
    '#!/usr/bin/env node\n',
  );
}

test('tar.gz archives round-trip the product layout', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    extractTarGz({ archiveFile, targetDir });
    assertExtracted(targetDir);
    if (process.platform !== 'win32') {
      const mode =
        fs.statSync(path.join(targetDir, 'kungfu-cli-test', 'kungfu', 'kungfu'))
          .mode & 0o777;
      assert.equal(mode, 0o755);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz archives preserve portable internal symbolic links', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir, productRoot } = makeFixture(parent);
    fs.symlinkSync('kungfu', path.join(productRoot, 'kungfu', 'python'));
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    extractTarGz({ archiveFile, targetDir });
    const link = path.join(targetDir, 'kungfu-cli-test', 'kungfu', 'python');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), 'kungfu');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz archive creation rejects absolute and escaping symbolic links', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  for (const link of ['/tmp/outside', '../../../outside']) {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-archive-test-'),
    );
    try {
      const { sourceDir, productRoot } = makeFixture(parent);
      fs.symlinkSync(link, path.join(productRoot, 'kungfu', 'python'));
      assert.throws(
        () =>
          writeTarGz({
            sourceDir,
            outputFile: path.join(parent, 'product.tar.gz'),
          }),
        /archive symlink (?:must be relative|escapes source)/u,
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('zip archives round-trip the product layout', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.zip');
    const targetDir = path.join(parent, 'zip-out');
    writeZip({ sourceDir, outputFile: archiveFile });
    extractZip({ archiveFile, targetDir });
    assertExtracted(targetDir);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
