// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VECTOR_ROOT = path.join(
  ROOT,
  'framework/format/conformance/portable-format-vectors/v1/bytes',
);

const PAGE_SIZE = 2 * 1024 * 1024;
const PAGE_HEADER =
  '8d4cb2e320000000000020000000000048000000000000002000000000000000';
const FRAME_HEADER =
  '500000004800000000002a36fe9c97177b002a36fe9c97177929edff443322118877665501000000ccbbaa9900000000080706050403020118171615141312112827262524232221';
const UNKNOWN_PAYLOAD = 'deadbeef00ff4180';
const KFR2_MAPPING_RECEIPT =
  '4b465232402000000000000000236b756e6766752e666163742e726f6f742d6d617070696e672d726563656970742f7631000000000000000600000000000000012000000000000000236b756e6766752e666163742e726f6f742d6d617070696e672d726563656970742f7631000000000000000220000000000000001e7368613235362d6c656e6774682d6672616d65642d6669656c64732d763100000000000000032000000000000000477368613235363a61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161000000000000000420000000000000001d6b756e6766752e666163742d726f6f742e63616e6f6e6963616c2f763200000000000000052000000000000000477368613235363a6262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626200000000000000062000000000000000477368613235363a63636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363';

function journalPage() {
  const bytes = Buffer.alloc(PAGE_SIZE);
  Buffer.from(PAGE_HEADER, 'hex').copy(bytes, 0);
  Buffer.from(FRAME_HEADER, 'hex').copy(bytes, 32);
  Buffer.from(UNKNOWN_PAYLOAD, 'hex').copy(bytes, 104);
  return bytes;
}

function framedAtoms(atoms) {
  const chunks = [];
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(atoms.length));
  chunks.push(count);
  for (const atom of atoms) {
    const body = Buffer.from(atom, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.length));
    chunks.push(length, body);
  }
  return Buffer.concat(chunks);
}

export function vectorBytes() {
  const current = journalPage();
  const future = Buffer.from(current);
  future.writeUInt32LE(0xe3b24c8e, 0);
  const corruptOffset = Buffer.from(current);
  corruptOffset.writeBigUInt64LE(BigInt(PAGE_SIZE + 8), 24);
  const truncated = current.subarray(0, 24);
  const kfr2 = Buffer.from(KFR2_MAPPING_RECEIPT, 'hex');
  const damagedKfr2 = kfr2.subarray(0, kfr2.length - 17);
  return new Map([
    ['journal-v1-unknown-carrier.bin', current],
    ['journal-v2-future-epoch.bin', future],
    ['journal-v1-corrupt-last-frame-offset.bin', corruptOffset],
    ['journal-v1-truncated-header.bin', truncated],
    [
      'fact-root-v1-legacy-atoms.bin',
      framedAtoms([
        'kungfu.fact.object/v1',
        'fact:11111111111111111111111111111111',
        'legacy.note',
      ]),
    ],
    ['fact-root-v2-mapping-receipt.bin', kfr2],
    ['fact-root-v2-damaged-receipt.bin', damagedKfr2],
    [
      'fact-root-v3-unsupported.bin',
      Buffer.concat([Buffer.from('KFR3\0', 'ascii'), kfr2.subarray(5)]),
    ],
  ]);
}

export function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function generatePortableFormatVectors({ write = false } = {}) {
  const failures = [];
  for (const [name, expected] of vectorBytes()) {
    const target = path.join(VECTOR_ROOT, name);
    if (write) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected);
      continue;
    }
    if (!fs.existsSync(target)) {
      failures.push(`${name}: missing`);
      continue;
    }
    const actual = fs.readFileSync(target);
    if (!actual.equals(expected))
      failures.push(
        `${name}: generated ${sha256(expected)}, retained ${sha256(actual)}`,
      );
  }
  if (failures.length)
    throw new Error(
      `portable format vector drift:\n- ${failures.join('\n- ')}`,
    );
  return [...vectorBytes()].map(([name, bytes]) => ({
    name,
    bytes: bytes.length,
    root: sha256(bytes),
  }));
}

function main() {
  const write = process.argv.includes('--write');
  const result = generatePortableFormatVectors({ write });
  console.log(
    `[portable-format-vectors] ${write ? 'wrote' : 'verified'} ${result.length} retained byte vectors`,
  );
  for (const entry of result)
    console.log(`${entry.root}  ${entry.bytes}  ${entry.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
