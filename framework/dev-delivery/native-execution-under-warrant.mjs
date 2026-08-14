#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { digest } from '../../scripts/affected-native-proof.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;

function flag(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || '';
}

function exact(value, pattern, label) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} is not exact`);
  return normalized;
}

function positiveInteger(value, label, fallback = '') {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function phases(value) {
  const parsed = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parsed.length === 0) throw new Error('allowed phases are required');
  return new Set(parsed);
}

function concurrentStateWrite(error) {
  return /Update is not a fast forward|expected-old state drift/u.test(
    String(error?.message || error),
  );
}

function assertLiveBinding(result, expected, observedAt) {
  const observation = result?.observation;
  const warrant = observation?.activeWarrant;
  const candidate = observation?.activeCandidate;
  if (!warrant || !candidate)
    throw new Error('exact active Delivery Warrant is missing');
  if (warrant.candidateId !== candidate.candidateId)
    throw new Error('active Delivery Warrant candidate binding mismatch');
  if (
    warrant.pullRequestNumber !== expected.pullRequestNumber ||
    candidate.pullRequestNumber !== expected.pullRequestNumber
  )
    throw new Error('active Delivery Warrant pull request mismatch');
  if (
    warrant.sourceHead !== expected.sourceHead ||
    candidate.sourceHead !== expected.sourceHead
  )
    throw new Error('active Delivery Warrant source head mismatch');
  if (!expected.allowedPhases.has(warrant.phase))
    throw new Error(
      `active Delivery Warrant phase ${warrant.phase} is not allowed`,
    );
  if (!ROOT.test(String(warrant.fencingToken || '')))
    throw new Error('active Delivery Warrant fencing token is not exact');
  if (!Number.isInteger(warrant.generation) || warrant.generation < 1)
    throw new Error('active Delivery Warrant generation is not exact');
  if (
    !Number.isFinite(Date.parse(warrant.expiresAt || '')) ||
    Date.parse(warrant.expiresAt) <= Date.parse(observedAt)
  )
    throw new Error('active Delivery Warrant lease expired');
  if (expected.candidateId && warrant.candidateId !== expected.candidateId)
    throw new Error('active Delivery Warrant changed candidate');
  if (expected.fencingToken && warrant.fencingToken !== expected.fencingToken)
    throw new Error('stale Delivery Warrant fencing token');
  if (
    expected.leaseGeneration &&
    warrant.generation !== expected.leaseGeneration
  )
    throw new Error('stale Delivery Warrant lease generation');
  return warrant;
}

async function runtimeDependencies(runtimeRoot) {
  const commandModule = await import(
    pathToFileURL(path.join(runtimeRoot, 'scripts/dev-delivery-warrant.mjs'))
      .href
  );
  const runnerModule = await import(
    pathToFileURL(path.join(runtimeRoot, 'scripts/dev-delivery-native-run.mjs'))
      .href
  );
  return {
    observe: (options) =>
      commandModule.runDevDeliveryCommand({
        command: 'observe',
        repository: options.repository,
        branch: options.branch,
      }),
    heartbeat: (options) =>
      commandModule.runDevDeliveryCommand({
        command: 'heartbeat',
        repository: options.repository,
        branch: options.branch,
        fencingToken: options.fencingToken,
        leaseGeneration: options.leaseGeneration,
        leaseSeconds: options.leaseSeconds,
        execute: true,
      }),
    runNative: runnerModule.runNativeWithHeartbeat,
  };
}

export async function runNativeExecutionUnderWarrant(
  options,
  dependencies = {},
) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const repository = String(options.repository || '').trim();
  const branch = String(options.branch || '').trim();
  const sourceHead = exact(options.sourceHead, SHA, 'source head');
  const qualifiedBase = exact(options.qualifiedBase, SHA, 'qualified base');
  const toolchainRoot = exact(options.toolchainRoot, ROOT, 'toolchain root');
  const environmentRoot = exact(
    options.environmentRoot,
    ROOT,
    'environment root',
  );
  const pullRequestNumber = positiveInteger(
    options.pullRequestNumber,
    'pull request',
  );
  const allowedPhases = phases(options.allowedPhases);
  const leaseSeconds = positiveInteger(
    options.leaseSeconds,
    'lease seconds',
    '5400',
  );
  const intervalMs =
    positiveInteger(options.heartbeatSeconds, 'heartbeat seconds', '300') *
    1000;
  if (intervalMs >= leaseSeconds * 1000)
    throw new Error('heartbeat interval must be shorter than the lease');
  if (!repository) throw new Error('repository is required');
  if (!branch) throw new Error('protected branch is required');
  if (!String(options.command || '').trim())
    throw new Error('native command is required');

  const runtime = Object.keys(dependencies).length
    ? dependencies
    : await runtimeDependencies(path.resolve(options.runtimeRoot));
  const clock = dependencies.now || (() => new Date().toISOString());
  const wait =
    dependencies.wait ||
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const initial = await runtime.observe({ repository, branch });
  const warrant = assertLiveBinding(
    initial,
    { pullRequestNumber, sourceHead, allowedPhases },
    clock(),
  );
  const warrantBinding = {
    repository,
    branch,
    pullRequestNumber,
    sourceHead,
    candidateId: warrant.candidateId,
    fencingToken: warrant.fencingToken,
    leaseGeneration: warrant.generation,
  };

  const heartbeat = async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const result = await runtime.heartbeat({
          repository,
          branch,
          fencingToken: warrantBinding.fencingToken,
          leaseGeneration: warrantBinding.leaseGeneration,
          leaseSeconds,
        });
        assertLiveBinding(
          result,
          { ...warrantBinding, allowedPhases },
          clock(),
        );
        return;
      } catch (error) {
        if (!concurrentStateWrite(error) || attempt === 5) throw error;
        const latest = await runtime.observe({ repository, branch });
        assertLiveBinding(
          latest,
          { ...warrantBinding, allowedPhases },
          clock(),
        );
        await wait(200 * 2 ** (attempt - 1));
      }
    }
  };
  const native = await runtime.runNative({
    command: options.command,
    cwd,
    heartbeat,
    executionBinding: {
      repository,
      protectedBase: branch,
      sourceHead,
      qualifiedBase,
      toolchainRoot,
      environmentRoot,
    },
    intervalMs,
    terminationGraceMs: Number(options.terminationGraceMs || 10_000),
    terminationKillMs: Number(options.terminationKillMs || 5_000),
  });
  // The protected runner heartbeats before spawn and during execution. Repeat
  // one exact heartbeat here so a final-beat failure can never be hidden by a
  // child that happened to exit at the same instant as fence loss.
  await heartbeat();
  const receiptBody = {
    schema: 'kungfu.dev-delivery-native-execution-under-warrant/v1',
    outcome: 'succeeded',
    ...warrantBinding,
    qualifiedBase,
    toolchainRoot,
    environmentRoot,
    commandRoot: digest({ command: options.command }),
    nativeRunReceiptRoot: native.receiptRoot,
    nativeExecutionReceipt: native,
  };
  const receipt = { ...receiptBody, receiptRoot: digest(receiptBody) };
  if (options.output) {
    const output = path.resolve(cwd, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

async function main() {
  const args = process.argv.slice(2);
  const receipt = await runNativeExecutionUnderWarrant({
    repository: flag(args, 'repository', process.env.GITHUB_REPOSITORY),
    branch: flag(args, 'branch', process.env.GITHUB_BASE_REF),
    pullRequestNumber: flag(args, 'pull-request'),
    sourceHead: flag(args, 'source-head'),
    qualifiedBase: flag(args, 'qualified-base'),
    toolchainRoot: flag(args, 'toolchain-root'),
    environmentRoot: flag(args, 'environment-root'),
    allowedPhases: flag(args, 'allowed-phases'),
    runtimeRoot: flag(args, 'runtime-root'),
    command: process.env.KUNGFU_NATIVE_COMMAND,
    heartbeatSeconds: flag(args, 'heartbeat-seconds', '300'),
    leaseSeconds: flag(args, 'lease-seconds', '5400'),
    output: flag(args, 'output'),
  });
  process.stdout.write(
    `Kungfu native execution retained Warrant ${receipt.receiptRoot}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Kungfu native Warrant execution: ${error.message}`);
    process.exit(1);
  });
