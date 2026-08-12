// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

function paxRecord(key, value) {
  const content = `${key}=${value}\n`;
  let length = Buffer.byteLength(content) + 2;
  while (Buffer.byteLength(`${length} ${content}`) !== length) {
    length = Buffer.byteLength(`${length} ${content}`);
  }
  return Buffer.from(`${length} ${content}`);
}

function archiveWithPaxHeader(archiveFile) {
  const archive = zlib.gunzipSync(fs.readFileSync(archiveFile));
  const firstHeader = Buffer.from(archive.subarray(0, 512));
  const name = firstHeader.toString('utf8', 0, 100).replace(/\0.*$/u, '');
  const prefix = firstHeader.toString('utf8', 345, 500).replace(/\0.*$/u, '');
  const entryPath = prefix ? `${prefix}/${name}` : name;
  const body = Buffer.concat([
    paxRecord('path', entryPath),
    paxRecord('SCHILY.xattr.com.apple.provenance', 'opaque-test-value'),
  ]);
  firstHeader.fill(0, 0, 100);
  firstHeader.write('././@PaxHeader', 0, 100, 'utf8');
  firstHeader.write('x', 156, 1, 'ascii');
  firstHeader.fill(0, 124, 136);
  firstHeader.write(body.length.toString(8).padStart(11, '0'), 124, 11, 'ascii');
  firstHeader.fill(0x20, 148, 156);
  const checksum = [...firstHeader].reduce((sum, byte) => sum + byte, 0);
  firstHeader.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  firstHeader[154] = 0;
  firstHeader[155] = 0x20;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  fs.writeFileSync(
    archiveFile,
    zlib.gzipSync(Buffer.concat([firstHeader, body, padding, archive])),
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

test('tar.gz extraction accepts safe POSIX PAX metadata', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    archiveWithPaxHeader(archiveFile);
    extractTarGz({ archiveFile, targetDir });
    assertExtracted(targetDir);
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
