// SPDX-License-Identifier: Apache-2.0
// Small archive writer for product CLI packages. It avoids adding another
// packaging dependency to the release path: Unix gets tar.gz, Windows gets zip.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TAR_BLOCK = 512;
const ZIP_EPOCH = new Date('1980-01-01T00:00:00Z');
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_COMPRESSION_LEVEL = 9;

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function unsafeArchivePath(name) {
  return (
    !name ||
    name.includes('\\') ||
    path.isAbsolute(name) ||
    /^[a-zA-Z]:/.test(name) ||
    name
      .split('/')
      .filter(Boolean)
      .some((part) => part === '..')
  );
}

function extractPath(targetDir, name) {
  if (unsafeArchivePath(name)) {
    throw new Error(`unsafe archive path: ${name}`);
  }
  const resolved = path.resolve(targetDir, ...name.split('/').filter(Boolean));
  const targetRoot = path.resolve(targetDir);
  if (
    resolved !== targetRoot &&
    !resolved.startsWith(`${targetRoot}${path.sep}`)
  ) {
    throw new Error(`archive path escapes target: ${name}`);
  }
  return resolved;
}

function collectFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = fs.lstatSync(full);
        let link = '';
        if (entry.isSymbolicLink()) {
          link = fs.readlinkSync(full);
          if (path.isAbsolute(link) || /^[a-zA-Z]:/.test(link)) {
            throw new Error(
              `archive symlink must be relative: ${normalizePath(path.relative(root, full))}`,
            );
          }
          const resolved = path.resolve(path.dirname(full), link);
          const archiveRoot = path.resolve(root);
          if (
            resolved !== archiveRoot &&
            !resolved.startsWith(`${archiveRoot}${path.sep}`)
          ) {
            throw new Error(
              `archive symlink escapes source: ${normalizePath(path.relative(root, full))}`,
            );
          }
        }
        files.push({
          full,
          rel: normalizePath(path.relative(root, full)),
          stat,
          link,
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
  writeOctal(header, file.link ? 0 : file.stat.size, 124, 12);
  writeOctal(header, Math.floor(file.stat.mtimeMs / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header.write(file.link ? '2' : '0', 156, 1, 'ascii');
  if (file.link) {
    if (Buffer.byteLength(file.link) > 100) {
      throw new Error(`tar symlink target too long: ${file.rel}`);
    }
    header.write(file.link, 157, 100, 'utf8');
  }
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
    const body = file.link ? Buffer.alloc(0) : fs.readFileSync(file.full);
    chunks.push(tarHeader(file), body, tarPad(body.length));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(
    outputFile,
    zlib.gzipSync(Buffer.concat(chunks), { level: 9 }),
  );
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const sliceEnd =
    end >= offset && end < offset + length ? end : offset + length;
  return buffer.toString('utf8', offset, sliceEnd).replace(/\0.*$/, '');
}

function readTarOctal(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function chmodIfPossible(file, mode) {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Some filesystems/platforms do not preserve POSIX modes.
  }
}

function readPaxRecords(body) {
  const records = Object.create(null);
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error('invalid PAX record length');
    const lengthText = body.toString('ascii', offset, space);
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new Error('invalid PAX record length');
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end <= space + 1 ||
      end > body.length ||
      body[end - 1] !== 0x0a
    ) {
      throw new Error('malformed PAX record');
    }
    const record = body.toString('utf8', space + 1, end - 1);
    const separator = record.indexOf('=');
    if (separator <= 0) throw new Error('malformed PAX record');
    records[record.slice(0, separator)] = record.slice(separator + 1);
    offset = end;
  }
  return records;
}

function paxEntrySize(value, entryName) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`invalid PAX entry size for ${entryName}`);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`invalid PAX entry size for ${entryName}`);
  }
  return size;
}

export function extractTarGz({ archiveFile, targetDir }) {
  const buffer = zlib.gunzipSync(fs.readFileSync(archiveFile));
  fs.mkdirSync(targetDir, { recursive: true });
  let offset = 0;
  let pendingPax = null;
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const mode = readTarOctal(header, 100, 8) || 0o644;
    const type = readTarString(header, 156, 1) || '0';
    const headerSize = readTarOctal(header, 124, 12);
    const headerName = prefix ? `${prefix}/${name}` : name;
    if (!Number.isSafeInteger(headerSize) || headerSize < 0) {
      throw new Error(`invalid tar entry size for ${headerName}`);
    }
    if (type === 'x' && pendingPax !== null) {
      throw new Error('consecutive PAX local headers are unsupported');
    }
    const size =
      type !== 'x' && pendingPax?.size !== undefined
        ? paxEntrySize(pendingPax.size, headerName)
        : headerSize;
    if (offset + size > buffer.length) {
      throw new Error(`truncated tar entry: ${headerName}`);
    }
    const body = buffer.subarray(offset, offset + size);
    offset += size + (size % TAR_BLOCK ? TAR_BLOCK - (size % TAR_BLOCK) : 0);

    if (type === 'x') {
      pendingPax = readPaxRecords(body);
      continue;
    }

    const pax = pendingPax;
    pendingPax = null;
    const entryName = pax?.path ?? headerName;
    const target = extractPath(targetDir, entryName);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type === '2') {
      const link = pax?.linkpath ?? readTarString(header, 157, 100);
      if (!link || path.isAbsolute(link) || /^[a-zA-Z]:/.test(link)) {
        throw new Error(`unsafe tar symlink for ${entryName}`);
      }
      const resolvedLink = path.resolve(path.dirname(target), link);
      const targetRoot = path.resolve(targetDir);
      if (
        resolvedLink !== targetRoot &&
        !resolvedLink.startsWith(`${targetRoot}${path.sep}`)
      ) {
        throw new Error(`tar symlink escapes target: ${entryName}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(link, target);
      continue;
    }
    if (type !== '0') {
      throw new Error(`unsupported tar entry type ${type} for ${entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    chmodIfPossible(target, mode);
  }
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

function localZipHeader({ name, body, compressedBody, stat }) {
  const nameBuf = Buffer.from(name);
  const header = Buffer.alloc(30);
  const when = dosDateTime(stat.mtime);
  const crc = crc32(body);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
  header.writeUInt16LE(when.time, 10);
  header.writeUInt16LE(when.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedBody.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return { header, nameBuf, crc, when };
}

function centralZipHeader({
  nameBuf,
  body,
  compressedBody,
  stat,
  crc,
  when,
  offset,
}) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
  header.writeUInt16LE(when.time, 12);
  header.writeUInt16LE(when.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedBody.length, 20);
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
    if (file.link) {
      throw new Error(
        `zip product archives do not support symbolic links: ${file.rel}`,
      );
    }
    const body = fs.readFileSync(file.full);
    const compressedBody = zlib.deflateRawSync(body, {
      level: ZIP_COMPRESSION_LEVEL,
    });
    const entry = localZipHeader({
      name: file.rel,
      body,
      compressedBody,
      stat: file.stat,
    });
    local.push(entry.header, entry.nameBuf, compressedBody);
    central.push(
      centralZipHeader({
        ...entry,
        body,
        compressedBody,
        stat: file.stat,
        offset,
      }),
      entry.nameBuf,
    );
    offset +=
      entry.header.length + entry.nameBuf.length + compressedBody.length;
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

export function extractZip({ archiveFile, targetDir }) {
  const buffer = fs.readFileSync(archiveFile);
  fs.mkdirSync(targetDir, { recursive: true });
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      throw new Error(`unsupported zip signature at ${offset}: ${signature}`);
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const bodyStart = nameStart + nameLength + extraLength;
    const bodyEnd = bodyStart + compressedSize;
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
      throw new Error(
        `unsupported zip compression method ${method} for ${name}`,
      );
    }
    if (method === ZIP_METHOD_STORE && compressedSize !== uncompressedSize) {
      throw new Error(`zip entry size mismatch for ${name}`);
    }
    const compressedBody = buffer.subarray(bodyStart, bodyEnd);
    const body =
      method === ZIP_METHOD_DEFLATE
        ? zlib.inflateRawSync(compressedBody)
        : compressedBody;
    if (body.length !== uncompressedSize) {
      throw new Error(`zip entry size mismatch for ${name}`);
    }
    const target = extractPath(targetDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    offset = bodyEnd;
  }
}
