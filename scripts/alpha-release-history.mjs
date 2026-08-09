#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  summarizeAlphaReleaseSlo,
  verifyAlphaReleaseTimeline,
} from './alpha-release-timeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_SCHEMA = 'kungfu.alpha-release-history/v1';
const ENTRY_SCHEMA = 'kungfu.alpha-release-history-entry/v1';
const APPEND_SCHEMA = 'kungfu.alpha-release-history-append-receipt/v1';
const MAX_ENTRIES = 10_000;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text || /[\r\n\0]/u.test(text)) throw new Error(`${label} is required`);
  return text;
}

function readJson(file, label) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_OBJECT_BYTES)
    throw new Error(`${label} exceeds the bounded object size`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function objectPath(history, root) {
  return path.join(history, 'objects', 'sha256', `${root.slice(7)}.json`);
}

function entryPath(history, sequence, root) {
  return path.join(
    history,
    'entries',
    `${String(sequence).padStart(8, '0')}-${root.slice(7)}.json`,
  );
}

function emptyManifest(contractDigest) {
  const body = {
    schema: HISTORY_SCHEMA,
    contractDigest,
    entryCount: 0,
    headEntryRoot: null,
    entryRoots: [],
  };
  return { ...body, historyRoot: digest(body) };
}

export function initializeAlphaReleaseHistory({ history, contract }) {
  const directory = path.resolve(history);
  const manifestPath = path.join(directory, 'manifest.json');
  if (fs.existsSync(manifestPath))
    return verifyAlphaReleaseHistory({ history: directory, contract }).manifest;
  const manifest = emptyManifest(digest(contract));
  writeJsonAtomic(manifestPath, manifest);
  verifyAlphaReleaseHistory({ history: directory, contract });
  return manifest;
}

function writeObject(history, value) {
  const root = digest(value);
  const target = objectPath(history, root);
  if (fs.existsSync(target)) {
    if (digest(readJson(target, `history object ${root}`)) !== root)
      throw new Error(`history object collision or corruption: ${root}`);
  } else {
    writeJsonAtomic(target, value);
  }
  return root;
}

function readEntry(history, sequence, root) {
  const entry = readJson(
    entryPath(history, sequence, root),
    `history entry ${sequence}`,
  );
  const { entryRoot, ...body } = entry;
  if (entryRoot !== root || entryRoot !== digest(body))
    throw new Error(`history entry root mismatch at sequence ${sequence}`);
  return entry;
}

function timelineIdentity(receipt) {
  return `${required(
    receipt?.candidate?.sourceCommit,
    'timeline source commit',
  )}:${required(
    receipt?.candidate?.promotionCommit,
    'timeline promotion commit',
  )}`;
}

export function verifyAlphaReleaseHistory({
  history,
  contract,
  allowMissing = false,
}) {
  const directory = path.resolve(history);
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (allowMissing)
      return {
        manifest: emptyManifest(digest(contract)),
        entries: [],
        receipts: [],
        compatibleReceipts: [],
        compatibleCount: 0,
        incompatibleCount: 0,
      };
    throw new Error('Alpha release history manifest is missing');
  }
  const manifest = readJson(manifestPath, 'history manifest');
  const { historyRoot, ...manifestBody } = manifest;
  if (
    manifest.schema !== HISTORY_SCHEMA ||
    historyRoot !== digest(manifestBody)
  )
    throw new Error('Alpha release history manifest root mismatch');
  if (
    !Number.isInteger(manifest.entryCount) ||
    manifest.entryCount < 0 ||
    manifest.entryCount > MAX_ENTRIES ||
    manifest.entryRoots?.length !== manifest.entryCount
  )
    throw new Error('Alpha release history entry bound is invalid');
  const entryFiles = fs.existsSync(path.join(directory, 'entries'))
    ? fs
        .readdirSync(path.join(directory, 'entries'))
        .filter((file) => file.endsWith('.json'))
    : [];
  if (entryFiles.length !== manifest.entryCount)
    throw new Error('Alpha release history is partial or has orphan entries');
  const entries = [];
  const receipts = [];
  const compatibleReceipts = [];
  const referencedObjects = new Set();
  let previousEntryRoot = null;
  let compatibleCount = 0;
  let incompatibleCount = 0;
  for (let index = 0; index < manifest.entryRoots.length; index += 1) {
    const sequence = index + 1;
    const root = manifest.entryRoots[index];
    const entry = readEntry(directory, sequence, root);
    if (
      entry.schema !== ENTRY_SCHEMA ||
      entry.sequence !== sequence ||
      entry.previousEntryRoot !== previousEntryRoot
    )
      throw new Error(
        `Alpha release history chain drift at sequence ${sequence}`,
      );
    for (const objectRoot of [entry.timelineObjectRoot, entry.sloObjectRoot]) {
      const target = objectPath(directory, objectRoot);
      if (!fs.existsSync(target))
        throw new Error(
          `Alpha release history object is missing: ${objectRoot}`,
        );
      const value = readJson(target, `history object ${objectRoot}`);
      if (digest(value) !== objectRoot)
        throw new Error(
          `Alpha release history object root mismatch: ${objectRoot}`,
        );
      referencedObjects.add(objectRoot);
    }
    const receipt = readJson(
      objectPath(directory, entry.timelineObjectRoot),
      `timeline object ${entry.timelineObjectRoot}`,
    );
    if (
      receipt.receiptRoot !== entry.timelineReceiptRoot ||
      timelineIdentity(receipt) !== entry.candidateIdentity
    )
      throw new Error(`timeline identity drift at sequence ${sequence}`);
    try {
      verifyAlphaReleaseTimeline({ receipt, contract });
      compatibleCount += 1;
      compatibleReceipts.push(receipt);
    } catch (error) {
      if (!/timeline contract digest mismatch/u.test(error.message))
        throw error;
      incompatibleCount += 1;
    }
    entries.push(entry);
    receipts.push(receipt);
    previousEntryRoot = root;
  }
  if (manifest.headEntryRoot !== previousEntryRoot)
    throw new Error('Alpha release history head root mismatch');
  const objectFiles = fs.existsSync(path.join(directory, 'objects', 'sha256'))
    ? fs
        .readdirSync(path.join(directory, 'objects', 'sha256'))
        .filter((file) => file.endsWith('.json'))
    : [];
  if (objectFiles.length !== referencedObjects.size)
    throw new Error('Alpha release history has orphan or missing objects');
  const totalBytes = [
    manifestPath,
    ...entryFiles.map((file) => path.join(directory, 'entries', file)),
    ...objectFiles.map((file) =>
      path.join(directory, 'objects', 'sha256', file),
    ),
  ].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  if (totalBytes > MAX_HISTORY_BYTES)
    throw new Error('Alpha release history exceeds the bounded total size');
  return {
    manifest,
    entries,
    receipts,
    compatibleReceipts,
    compatibleCount,
    incompatibleCount,
    totalBytes,
  };
}

export function appendAlphaReleaseHistory({
  history,
  timelineReceipt,
  contract,
}) {
  verifyAlphaReleaseTimeline({ receipt: timelineReceipt, contract });
  if (
    timelineReceipt.mode !== 'release' ||
    timelineReceipt.slo?.eligibleRealSample !== true
  )
    throw new Error('durable Alpha history admits only eligible real releases');
  const directory = path.resolve(history);
  const before = verifyAlphaReleaseHistory({
    history: directory,
    contract,
    allowMissing: true,
  });
  const identity = timelineIdentity(timelineReceipt);
  const existing = before.entries.find(
    (entry) => entry.candidateIdentity === identity,
  );
  if (existing) {
    if (existing.timelineReceiptRoot !== timelineReceipt.receiptRoot)
      throw new Error(
        'duplicate candidate identity substituted timeline evidence',
      );
    return {
      schema: APPEND_SCHEMA,
      status: 'replay',
      candidateIdentity: identity,
      timelineReceiptRoot: timelineReceipt.receiptRoot,
      historyRoot: before.manifest.historyRoot,
      entryRoot: existing.entryRoot,
      entryCount: before.manifest.entryCount,
    };
  }
  if (before.manifest.entryCount >= MAX_ENTRIES)
    throw new Error('Alpha release history reached its bounded entry count');
  const receipts = [...before.compatibleReceipts, timelineReceipt];
  const slo = summarizeAlphaReleaseSlo({ receipts, contract });
  const timelineObjectRoot = writeObject(directory, timelineReceipt);
  const sloObjectRoot = writeObject(directory, slo);
  const sequence = before.manifest.entryCount + 1;
  const entryBody = {
    schema: ENTRY_SCHEMA,
    sequence,
    previousEntryRoot: before.manifest.headEntryRoot,
    candidateIdentity: identity,
    timelineReceiptRoot: timelineReceipt.receiptRoot,
    timelineObjectRoot,
    sloObjectRoot,
    mode: timelineReceipt.mode,
  };
  const entry = { ...entryBody, entryRoot: digest(entryBody) };
  writeJsonAtomic(entryPath(directory, sequence, entry.entryRoot), entry);
  const manifestBody = {
    schema: HISTORY_SCHEMA,
    contractDigest: digest(contract),
    entryCount: sequence,
    headEntryRoot: entry.entryRoot,
    entryRoots: [...before.manifest.entryRoots, entry.entryRoot],
  };
  const manifest = {
    ...manifestBody,
    historyRoot: digest(manifestBody),
  };
  writeJsonAtomic(path.join(directory, 'manifest.json'), manifest);
  verifyAlphaReleaseHistory({ history: directory, contract });
  return {
    schema: APPEND_SCHEMA,
    status: 'appended',
    candidateIdentity: identity,
    timelineReceiptRoot: timelineReceipt.receiptRoot,
    historyRoot: manifest.historyRoot,
    entryRoot: entry.entryRoot,
    entryCount: manifest.entryCount,
    slo,
  };
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid history option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  const contract = readJson(
    path.resolve(
      options.contract ||
        path.join(
          ROOT,
          'docs/qualification/alpha-release-latency.contract.json',
        ),
    ),
    'Alpha latency contract',
  );
  const history = required(options.history, '--history');
  if (command === 'init') {
    const manifest = initializeAlphaReleaseHistory({ history, contract });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'initialized',
          historyRoot: manifest.historyRoot,
          entryCount: manifest.entryCount,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const result = verifyAlphaReleaseHistory({ history, contract });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'verified',
          historyRoot: result.manifest.historyRoot,
          entryCount: result.manifest.entryCount,
          compatibleCount: result.compatibleCount,
          incompatibleCount: result.incompatibleCount,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'export') {
    const result = verifyAlphaReleaseHistory({ history, contract });
    const output = path.resolve(required(options.out, '--out'));
    fs.mkdirSync(output, { recursive: true });
    result.compatibleReceipts.forEach((receipt, index) =>
      writeJsonAtomic(
        path.join(output, `history-${String(index + 1).padStart(8, '0')}.json`),
        receipt,
      ),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'exported',
          historyRoot: result.manifest.historyRoot,
          receiptCount: result.compatibleReceipts.length,
          output,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'append') {
    const result = appendAlphaReleaseHistory({
      history,
      contract,
      timelineReceipt: readJson(
        path.resolve(required(options.receipt, '--receipt')),
        'timeline receipt',
      ),
    });
    if (options.out) writeJsonAtomic(path.resolve(options.out), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown Alpha history command: ${command || '<missing>'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
