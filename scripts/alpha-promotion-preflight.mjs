#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'kungfu.alpha-promotion-preflight-receipt/v1';
const REQUIRED_PLATFORMS = ['linux-x64', 'macos-arm64', 'windows-x64'];
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ROOT_FILES = {
  workflow: [
    '.github/actions/require-alpha-preflight/action.yml',
    '.github/workflows/alpha-promotion-preflight.yml',
    '.github/workflows/build.yml',
    '.github/workflows/embedding-membrane-spike.yml',
    '.github/workflows/release-new-version.yml',
    '.github/workflows/shifu-ci.yml',
  ],
  gate: ['shifu.gates.json'],
  toolchain: [
    '.node-version',
    'package.json',
    'pnpm-lock.yaml',
    'crates/libwasm-spike/rust-toolchain.toml',
    'crates/libwasm-spike/wasmer/Cargo.lock',
    'crates/libwasm-spike/wasmtime/Cargo.lock',
  ],
  policy: [
    '.buildchain/alpha-contract-lock.json',
    '.buildchain/contract-lock.json',
    'docs/qualification/gates/execution-profiles.json',
    'docs/release-promotion-rehearsal.contract.json',
    'scripts/alpha-promotion-preflight.mjs',
    'scripts/probe-release-platform.mjs',
  ],
};
const PLATFORM_CHECKS = {
  'linux-x64': ['exact-source', 'adr-cutover-history', 'cargo-locked-fetch'],
  'macos-arm64': ['exact-source', 'codesign-tool', 'cargo-locked-fetch'],
  'windows-x64': ['exact-source', 'windows-cmd-spawn', 'cargo-locked-fetch'],
};
const NON_REUSABLE_EVIDENCE = [
  'credentials',
  'notarization',
  'publication',
  'signing',
];

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

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function git(root, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(
        result.stderr || result.stdout || result.error?.message || '',
      ).trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

function fileRows(root, files) {
  return files.map((relative) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`preflight root input is missing: ${relative}`);
    }
    return {
      path: relative,
      digest: digest(fs.readFileSync(absolute)),
    };
  });
}

export function sourceBinding(root = ROOT) {
  const roots = Object.fromEntries(
    Object.entries(ROOT_FILES).map(([name, files]) => [
      `${name}Root`,
      digest(fileRows(root, files)),
    ]),
  );
  return {
    sourceCommit: git(root, ['rev-parse', 'HEAD^{commit}']),
    sourceTree: git(root, ['rev-parse', 'HEAD^{tree}']),
    ...roots,
  };
}

function withReceiptRoot(receipt) {
  return { ...receipt, receiptRoot: digest(receipt) };
}

export function buildPlatformReceipt({
  root = ROOT,
  platform,
  generatedAt = new Date().toISOString(),
  runtime = {},
}) {
  const checks = PLATFORM_CHECKS[platform];
  if (!checks) throw new Error(`unsupported preflight platform: ${platform}`);
  return withReceiptRoot({
    schema: SCHEMA,
    kind: 'platform',
    status: 'passed',
    generatedAt,
    platform,
    binding: sourceBinding(root),
    checks: Object.fromEntries(checks.map((check) => [check, 'passed'])),
    runtime,
    reuse: {
      scope: 'source-and-platform-probes-only',
      maxAgeSeconds: MAX_AGE_SECONDS,
      excludedEvidence: NON_REUSABLE_EVIDENCE,
    },
  });
}

function verifyRoot(receipt) {
  const { receiptRoot, ...body } = receipt;
  if (receiptRoot !== digest(body)) throw new Error('receipt root mismatch');
}

function assertBinding(actual, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (actual?.[field] !== value) {
      throw new Error(
        `${field} mismatch: expected ${value}, got ${String(actual?.[field])}`,
      );
    }
  }
}

export function aggregatePlatformReceipts({
  root = ROOT,
  receipts,
  generatedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(receipts) || receipts.length !== REQUIRED_PLATFORMS.length)
    throw new Error('aggregate requires exactly three platform receipts');
  const byPlatform = new Map();
  const binding = sourceBinding(root);
  for (const receipt of receipts) {
    verifyRoot(receipt);
    if (
      receipt.schema !== SCHEMA ||
      receipt.kind !== 'platform' ||
      receipt.status !== 'passed'
    )
      throw new Error('platform receipt is not qualifying');
    if (byPlatform.has(receipt.platform))
      throw new Error(`duplicate platform receipt: ${receipt.platform}`);
    assertBinding(receipt.binding, binding);
    for (const check of PLATFORM_CHECKS[receipt.platform] || []) {
      if (receipt.checks?.[check] !== 'passed')
        throw new Error(`${receipt.platform} omitted required check ${check}`);
    }
    byPlatform.set(receipt.platform, receipt);
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!byPlatform.has(platform))
      throw new Error(`missing platform receipt: ${platform}`);
  }
  return withReceiptRoot({
    schema: SCHEMA,
    kind: 'aggregate',
    status: 'passed',
    generatedAt,
    binding,
    platforms: REQUIRED_PLATFORMS.map((platform) => byPlatform.get(platform)),
    reuse: {
      scope: 'source-and-platform-probes-only',
      maxAgeSeconds: MAX_AGE_SECONDS,
      excludedEvidence: NON_REUSABLE_EVIDENCE,
    },
  });
}

export function verifyAggregateReceipt({
  root = ROOT,
  receipt,
  expectedSourceCommit = '',
  now = Date.now(),
}) {
  verifyRoot(receipt);
  if (
    receipt.schema !== SCHEMA ||
    receipt.kind !== 'aggregate' ||
    receipt.status !== 'passed'
  )
    throw new Error('aggregate receipt is not qualifying');
  const binding = sourceBinding(root);
  assertBinding(receipt.binding, binding);
  if (
    expectedSourceCommit &&
    receipt.binding.sourceCommit !== expectedSourceCommit
  )
    throw new Error(
      `sourceCommit mismatch: expected ${expectedSourceCommit}, got ${receipt.binding.sourceCommit}`,
    );
  const ageSeconds =
    (now - Date.parse(String(receipt.generatedAt || 'invalid'))) / 1000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > MAX_AGE_SECONDS
  )
    throw new Error(`preflight receipt age is outside ${MAX_AGE_SECONDS}s`);
  if (
    JSON.stringify(receipt.reuse?.excludedEvidence) !==
    JSON.stringify(NON_REUSABLE_EVIDENCE)
  )
    throw new Error('preflight receipt reuse exclusions drifted');
  const platforms = receipt.platforms?.map((entry) => entry.platform) || [];
  if (JSON.stringify(platforms) !== JSON.stringify(REQUIRED_PLATFORMS))
    throw new Error('aggregate platform coverage drifted');
  for (const platformReceipt of receipt.platforms) {
    verifyRoot(platformReceipt);
    if (
      platformReceipt.schema !== SCHEMA ||
      platformReceipt.kind !== 'platform' ||
      platformReceipt.status !== 'passed'
    )
      throw new Error(`${platformReceipt.platform} receipt is not qualifying`);
    assertBinding(platformReceipt.binding, binding);
    for (const check of PLATFORM_CHECKS[platformReceipt.platform] || []) {
      if (platformReceipt.checks?.[check] !== 'passed')
        throw new Error(
          `${platformReceipt.platform} omitted required check ${check}`,
        );
    }
  }
  return receipt;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid preflight option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === 'write-platform') {
    if (!options.platform || !options.out)
      throw new Error('write-platform requires --platform and --out');
    writeJson(
      path.resolve(options.out),
      buildPlatformReceipt({
        platform: options.platform,
        runtime: {
          node: process.version,
          rustc: options.rustc || '',
          cargo: options.cargo || '',
        },
      }),
    );
    return;
  }
  if (command === 'aggregate') {
    if (!options.inputs || !options.out)
      throw new Error('aggregate requires --inputs and --out');
    const receipts = fs
      .readdirSync(path.resolve(options.inputs))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) =>
        JSON.parse(
          fs.readFileSync(
            path.join(path.resolve(options.inputs), file),
            'utf8',
          ),
        ),
      );
    writeJson(
      path.resolve(options.out),
      aggregatePlatformReceipts({ receipts }),
    );
    return;
  }
  if (command === 'verify') {
    if (!options.receipt || !options['source-commit'])
      throw new Error('verify requires --receipt and --source-commit');
    const receipt = JSON.parse(
      fs.readFileSync(path.resolve(options.receipt), 'utf8'),
    );
    verifyAggregateReceipt({
      receipt,
      expectedSourceCommit: options['source-commit'],
    });
    process.stdout.write(
      `[alpha-preflight] verified ${receipt.receiptRoot} for ${receipt.binding.sourceCommit} tree ${receipt.binding.sourceTree}\n`,
    );
    return;
  }
  throw new Error(`unknown alpha preflight command: ${command || '<missing>'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
