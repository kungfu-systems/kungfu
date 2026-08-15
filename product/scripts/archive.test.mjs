// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
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

function readZipMethods(archiveFile) {
  const buffer = fs.readFileSync(archiveFile);
  const local = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    local.push({
      method: buffer.readUInt16LE(offset + 8),
      compressedSize,
      uncompressedSize: buffer.readUInt32LE(offset + 22),
      name: buffer.toString('utf8', offset + 30, offset + 30 + nameLength),
    });
    offset += 30 + nameLength + extraLength + compressedSize;
  }

  const central = [];
  while (buffer.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    central.push({
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { local, central };
}

function paxRecord(key, value) {
  const content = `${key}=${value}\n`;
  let length = Buffer.byteLength(content) + 2;
  while (Buffer.byteLength(`${length} ${content}`) !== length) {
    length = Buffer.byteLength(`${length} ${content}`);
  }
  return Buffer.from(`${length} ${content}`);
}

function malformedPaxRecord(content) {
  const value = `${content}\n`;
  let length = Buffer.byteLength(value) + 2;
  while (Buffer.byteLength(`${length} ${value}`) !== length) {
    length = Buffer.byteLength(`${length} ${value}`);
  }
  return Buffer.from(`${length} ${value}`);
}

function prependPaxHeader(archiveFile, bodySource) {
  const archive = zlib.gunzipSync(fs.readFileSync(archiveFile));
  const header = Buffer.from(archive.subarray(0, 512));
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/u, '');
  const entryPath = prefix ? `${prefix}/${name}` : name;
  const body =
    typeof bodySource === 'function' ? bodySource(entryPath) : bodySource;
  header.fill(0, 0, 100);
  header.write('././@PaxHeader', 0, 100, 'utf8');
  header.write('x', 156, 1, 'ascii');
  header.fill(0, 124, 136);
  header.write(body.length.toString(8).padStart(11, '0'), 124, 11, 'ascii');
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  fs.writeFileSync(
    archiveFile,
    zlib.gzipSync(Buffer.concat([header, body, padding, archive])),
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

test('tar.gz extraction accepts safe POSIX PAX local metadata', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    prependPaxHeader(archiveFile, (entryPath) =>
      Buffer.concat([
        paxRecord('path', entryPath),
        paxRecord('SCHILY.xattr.com.apple.provenance', 'opaque-test-value'),
      ]),
    );
    extractTarGz({ archiveFile, targetDir });
    assertExtracted(targetDir);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz extraction rejects traversal in a PAX path override', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-archive-test-'));
  try {
    const { sourceDir } = makeFixture(parent);
    const archiveFile = path.join(parent, 'product.tar.gz');
    const targetDir = path.join(parent, 'tar-out');
    writeTarGz({ sourceDir, outputFile: archiveFile });
    prependPaxHeader(archiveFile, paxRecord('path', '../outside'));
    assert.throws(
      () => extractTarGz({ archiveFile, targetDir }),
      /unsafe archive path: \.\.\/outside/u,
    );
    assert.equal(fs.existsSync(path.join(parent, 'outside')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('tar.gz extraction rejects malformed PAX records', () => {
  for (const body of [
    Buffer.from('not-a-length path=value\n'),
    Buffer.from('99 path=value\n'),
    malformedPaxRecord('pathvalue'),
  ]) {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-archive-test-'),
    );
    try {
      const { sourceDir } = makeFixture(parent);
      const archiveFile = path.join(parent, 'product.tar.gz');
      writeTarGz({ sourceDir, outputFile: archiveFile });
      prependPaxHeader(archiveFile, body);
      assert.throws(
        () =>
          extractTarGz({
            archiveFile,
            targetDir: path.join(parent, 'tar-out'),
          }),
        /(?:invalid PAX record length|malformed PAX record)/u,
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
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
    const compressible = path.join(sourceDir, 'kungfu-cli-test', 'payload.txt');
    fs.writeFileSync(compressible, 'kungfu product payload\n'.repeat(4096));
    writeZip({ sourceDir, outputFile: archiveFile });
    const methods = readZipMethods(archiveFile);
    assert.ok(methods.local.length > 0);
    assert.deepEqual(methods.central, methods.local);
    assert.ok(methods.local.every((entry) => entry.method === 8));
    const payload = methods.local.find((entry) =>
      entry.name.endsWith('/payload.txt'),
    );
    assert.ok(payload);
    assert.ok(payload.compressedSize < payload.uncompressedSize / 100);
    extractZip({ archiveFile, targetDir });
    assertExtracted(targetDir);
    assert.equal(
      fs.readFileSync(
        path.join(targetDir, 'kungfu-cli-test', 'payload.txt'),
        'utf8',
      ),
      'kungfu product payload\n'.repeat(4096),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
