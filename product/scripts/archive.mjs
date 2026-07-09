// SPDX-License-Identifier: Apache-2.0
// Small archive writer for product CLI packages. It avoids adding another
// packaging dependency to the release path: Unix gets tar.gz, Windows gets zip.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TAR_BLOCK = 512;
const ZIP_EPOCH = new Date('1980-01-01T00:00:00Z');

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function collectFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = fs.statSync(full);
        files.push({
          full,
          rel: normalizePath(path.relative(root, full)),
          stat,
        });
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function writeOctal(buffer, value, offset, length) {
  const text = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, '0');
  buffer.write(text.slice(-length + 1), offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function splitTarName(name) {
  const encoded = Buffer.byteLength(name);
  if (encoded <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const tail = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(tail) <= 100) {
      return { name: tail, prefix };
    }
  }
  throw new Error(`tar path too long: ${name}`);
}

function tarHeader(file) {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  const names = splitTarName(file.rel);
  header.write(names.name, 0, 100, 'utf8');
  writeOctal(header, file.stat.mode & 0o777, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, file.stat.size, 124, 12);
  writeOctal(header, Math.floor(file.stat.mtimeMs / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (names.prefix) header.write(names.prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, checksum, 148, 8);
  header[155] = 0x20;
  return header;
}

function tarPad(size) {
  const remainder = size % TAR_BLOCK;
  return remainder ? Buffer.alloc(TAR_BLOCK - remainder, 0) : Buffer.alloc(0);
}

export function writeTarGz({ sourceDir, outputFile }) {
  const chunks = [];
  for (const file of collectFiles(sourceDir)) {
    const body = fs.readFileSync(file.full);
    chunks.push(tarHeader(file), body, tarPad(body.length));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(
    outputFile,
    zlib.gzipSync(Buffer.concat(chunks), { level: 9 }),
  );
}

let crcTable;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const value = date < ZIP_EPOCH ? ZIP_EPOCH : date;
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function localZipHeader({ name, body, stat }) {
  const nameBuf = Buffer.from(name);
  const header = Buffer.alloc(30);
  const when = dosDateTime(stat.mtime);
  const crc = crc32(body);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(when.time, 10);
  header.writeUInt16LE(when.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return { header, nameBuf, crc, when };
}

function centralZipHeader({ nameBuf, body, stat, crc, when, offset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(when.time, 12);
  header.writeUInt16LE(when.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(body.length, 20);
  header.writeUInt32LE(body.length, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((stat.mode & 0o777) << 16, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export function writeZip({ sourceDir, outputFile }) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of collectFiles(sourceDir)) {
    const body = fs.readFileSync(file.full);
    const entry = localZipHeader({ name: file.rel, body, stat: file.stat });
    local.push(entry.header, entry.nameBuf, body);
    central.push(
      centralZipHeader({
        ...entry,
        body,
        stat: file.stat,
        offset,
      }),
      entry.nameBuf,
    );
    offset += entry.header.length + entry.nameBuf.length + body.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const footer = Buffer.alloc(22);
  const count = central.length / 2;
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(count, 8);
  footer.writeUInt16LE(count, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(offset, 16);
  footer.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, Buffer.concat([...local, ...central, footer]));
}
