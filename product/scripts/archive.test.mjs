// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { extractTarGz, extractZip, writeTarGz, writeZip } from './archive.mjs';

const TAR_BLOCK = 512;

function writeTarOctal(buffer, value, offset, length) {
  const text = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, '0');
  buffer.write(text.slice(-length + 1), offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function prependTarEntry({ archiveFile, name, type, body }) {
  const archive = zlib.gunzipSync(fs.readFileSync(archiveFile));
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, body.length, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarOctal(header, checksum, 148, 8);
  header[155] = 0x20;
  const remainder = body.length % TAR_BLOCK;
  const padding = remainder
    ? Buffer.alloc(TAR_BLOCK - remainder, 0)
    : Buffer.alloc(0);
  fs.writeFileSync(
    archiveFile,
    zlib.gzipSync(Buffer.concat([header, body, padding, archive])),
  );
}

function paxRecord(key, value) {
  const payload = Buffer.from(`${key}=${value}\n`);
  let length = payload.length + 2;
  while (Buffer.byteLength(`${length} `) + payload.length !== length) {
    length = Buffer.byteLength(`${length} `) + payload.length;
  }
  return Buffer.concat([Buffer.from(`${length} `), payload]);
}

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

test('tar.gz extraction accepts unrelated POSIX PAX metadata entries', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    prependTarEntry({
      archiveFile,
      name: '././@PaxHeader',
      type: 'x',
      body: Buffer.from('26 comment=signed-fixture\n'),
    });
    extractTarGz({ archiveFile, targetDir });
    assertExtracted(targetDir);
    assert.equal(fs.existsSync(path.join(targetDir, '@PaxHeader')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz extraction applies a POSIX PAX long path to the next entry', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    const longPath = `${'long-segment/'.repeat(10)}decision-admission-settlement.json`;
    writeTarGz({ sourceDir, outputFile: archiveFile });
    prependTarEntry({
      archiveFile,
      name: 'truncated-placeholder',
      type: '0',
      body: Buffer.from('{"ok":true}\n'),
    });
    prependTarEntry({
      archiveFile,
      name: '././@PaxHeader',
      type: 'x',
      body: paxRecord('path', longPath),
    });
    extractTarGz({ archiveFile, targetDir });
    assert.equal(
      fs.readFileSync(path.join(targetDir, ...longPath.split('/')), 'utf8'),
      '{"ok":true}\n',
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'truncated-placeholder')),
      false,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz extraction rejects unsafe and malformed POSIX PAX paths', () => {
  for (const body of [
    paxRecord('path', '../../outside'),
    Buffer.from('9 path=x'),
  ]) {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-archive-test-'),
    );
    try {
      const { sourceDir } = makeFixture(parent);
      const archiveFile = path.join(parent, 'product.tar.gz');
      writeTarGz({ sourceDir, outputFile: archiveFile });
      prependTarEntry({
        archiveFile,
        name: 'concrete-entry',
        type: '0',
        body: Buffer.from('content'),
      });
      prependTarEntry({
        archiveFile,
        name: '././@PaxHeader',
        type: 'x',
        body,
      });
      assert.throws(
        () =>
          extractTarGz({ archiveFile, targetDir: path.join(parent, 'out') }),
        /(?:unsafe archive path|invalid PAX record)/u,
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('tar.gz extraction still rejects unknown entry types', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    prependTarEntry({
      archiveFile,
      name: 'unsupported-entry',
      type: '7',
      body: Buffer.alloc(0),
    });
    assert.throws(
      () => extractTarGz({ archiveFile, targetDir: path.join(parent, 'out') }),
      /unsupported tar entry type 7/u,
    );
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
