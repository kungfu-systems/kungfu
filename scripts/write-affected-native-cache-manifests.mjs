#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyPortableDevCachePlan } from '@kungfu-tech/buildchain/portable-dev-cache';

import { partitionAffectedNativePlan } from './run-core-affected-native.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const LAYER_PATHS = {
  dependency: ['~/.conan2/p'],
  compiler: ['~/.cache/ccache'],
};
const IDENTITY_FILES = [
  '.buildchain-version',
  '.node-version',
  'pnpm-lock.yaml',
  'framework/core/conanfile.py',
  'framework/core/package.json',
  'framework/core/pyproject.toml',
  'framework/core/uv.lock',
];

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

export function affectedNativeCompilerPlanDigest(
  planDigest,
  executionPartition,
) {
  return digest({
    planDigest,
    executionPartition: {
      count: executionPartition.count,
      index: executionPartition.index,
      coverageDigest: executionPartition.coverageDigest,
      partitionDigest: executionPartition.partitionDigest,
    },
  });
}

function fileIdentity(root) {
  return IDENTITY_FILES.map((relative) => ({
    path: relative,
    digest: digest(fs.readFileSync(path.join(root, relative))),
  }));
}

function tool(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return {
    command,
    status: result.status ?? 1,
    version:
      `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim() ||
      'unavailable',
  };
}

export function createAffectedNativeCacheManifests({
  root = ROOT,
  plan,
  env = process.env,
  toolFacts = null,
  partitionCount = Number(env.KUNGFU_AFFECTED_NATIVE_PARTITION_COUNT || 1),
  partitionIndex = Number(env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX || 0),
}) {
  if (plan?.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('unsupported affected-native plan schema');
  }
  if (!plan.profile || !plan.closureComponents?.length) {
    throw new Error('portable cache manifests require a native plan');
  }
  const files = fileIdentity(root);
  const tools = toolFacts || [
    tool(env.CXX || 'c++'),
    tool('cmake'),
    tool('ccache'),
    tool('node'),
  ];
  const executionPartition = partitionAffectedNativePlan(
    plan,
    partitionCount,
    partitionIndex,
  );
  const cacheProfileDigest = digest({
    profile: 'core-affected-native-v1',
    authority: plan.authority,
    platformTier: plan.platformTier,
  });
  const commonIdentity = {
    platform: (env.RUNNER_OS || process.platform).toLowerCase(),
    arch: (env.RUNNER_ARCH || process.arch).toLowerCase(),
    runnerImage: env.ImageOS || env.RUNNER_IMAGE || 'ubuntu-24.04',
    toolchainDigest: digest({ tools, node: process.version }),
    dependencyLockDigest: digest(files),
    profileDigest: cacheProfileDigest,
    sourceSha: plan.head,
    planDigest: plan.planDigest,
  };
  const manifest = (layer, roots, identity) => ({
    schema: 'buildchain.portable-dev-cache-manifest/v1',
    layer,
    roots,
    identity,
  });
  return {
    dependency: manifest(
      'dependency',
      [{ id: 'conan-packages', path: '~/.conan2/p' }],
      commonIdentity,
    ),
    compiler: manifest(
      'compiler',
      [{ id: 'ccache', path: '~/.cache/ccache' }],
      executionPartition.count === 1
        ? commonIdentity
        : {
            ...commonIdentity,
            planDigest: affectedNativeCompilerPlanDigest(
              commonIdentity.planDigest,
              executionPartition,
            ),
          },
    ),
  };
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyAffectedPlan(plan) {
  assert(
    plan?.schema === 'kungfu.core-affected-native-plan/v1',
    'unsupported affected-native plan schema',
  );
  const { planDigest, ...body } = plan;
  assert(planDigest === digest(body), 'affected-native plan digest drift');
  assert(SHA_RE.test(plan.head || ''), 'affected-native plan head is invalid');
  return plan;
}

function verifyReceipt(receipt, cachePlan, layer, sourceSha) {
  verifyPortableDevCachePlan(cachePlan);
  assert(
    cachePlan.provider === 'github-actions-cache',
    `${layer} cache provider is invalid`,
  );
  assert(cachePlan.manifest.layer === layer, `${layer} cache plan layer drift`);
  assert(
    JSON.stringify(cachePlan.paths) === JSON.stringify(LAYER_PATHS[layer]),
    `${layer} cache roots are outside the promotion authority`,
  );
  assert(
    receipt?.schema === 'buildchain.portable-dev-cache-receipt/v1',
    `${layer} receipt schema is invalid`,
  );
  assert(receipt.layer === layer, `${layer} receipt layer drift`);
  assert(receipt.sourceSha === sourceSha, `${layer} receipt source drift`);
  assert(
    receipt.planDigest === cachePlan.planDigest,
    `${layer} receipt plan drift`,
  );
  assert(
    receipt.exactRootDigest === cachePlan.exactRootDigest,
    `${layer} receipt exact-root drift`,
  );
  assert(
    receipt.compatibilityDigest === cachePlan.compatibilityDigest,
    `${layer} receipt compatibility drift`,
  );
  assert(
    receipt.validation?.status === 'pass',
    `${layer} cache validation did not pass`,
  );
  assert(receipt.qualified === true, `${layer} cache receipt is not qualified`);
  if (receipt.coldFallbackRequired) {
    assert(
      receipt.coldFallbackStatus === 'passed',
      `${layer} cache miss did not pass the cold fallback`,
    );
  } else {
    assert(receipt.usable === true, `${layer} restored cache is not usable`);
  }
  const { receiptDigest, ...receiptBody } = receipt;
  assert(
    receiptDigest === digest(receiptBody),
    `${layer} receipt digest drift`,
  );
}

function verifyArchive(file, layer) {
  const listed = spawnSync('tar', ['-tf', file], {
    encoding: 'utf8',
    shell: false,
  });
  assert(
    listed.status === 0,
    `${layer} cache payload is not a readable tar archive`,
  );
  const expected = layer === 'dependency' ? '.conan2/p' : '.cache/ccache';
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(512);
  const stat = fs.fstatSync(descriptor);
  const entries = [];
  let offset = 0;
  let terminated = false;
  try {
    while (offset + header.length <= stat.size) {
      const bytes = fs.readSync(descriptor, header, 0, header.length, offset);
      assert(bytes === header.length, `${layer} cache payload is truncated`);
      if (header.every((byte) => byte === 0)) {
        terminated = true;
        break;
      }
      const field = (start, length) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .replace(/\0.*$/su, '');
      const name = field(0, 100);
      const prefix = field(345, 155);
      const entry = prefix ? `${prefix}/${name}` : name;
      const type = String.fromCharCode(header[156] || 48);
      assert(
        type === '0' || type === '5',
        `${layer} cache payload contains a non-file entry: ${entry}`,
      );
      const sizeField = field(124, 12).trim();
      assert(
        /^[0-7]*$/u.test(sizeField),
        `${layer} cache payload has an invalid entry size`,
      );
      const size = Number.parseInt(sizeField || '0', 8);
      assert(
        Number.isSafeInteger(size) && size >= 0,
        `${layer} cache payload has an invalid entry size`,
      );
      entries.push(entry);
      offset += 512 + Math.ceil(size / 512) * 512;
      assert(offset <= stat.size, `${layer} cache payload is truncated`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  assert(terminated, `${layer} cache payload has no terminal block`);
  assert(entries.length > 0, `${layer} cache payload is empty`);
  for (const entry of entries) {
    const normalized = entry.replace(/\/+$/, '');
    assert(
      normalized === expected || normalized.startsWith(`${expected}/`),
      `${layer} cache payload contains an unauthorized path: ${entry}`,
    );
    assert(
      !path.posix.isAbsolute(normalized) &&
        !normalized.split('/').includes('..'),
      `${layer} cache payload contains an unsafe path: ${entry}`,
    );
  }
}

function payloadLayer({ layer, archive, plan, receipt }) {
  verifyReceipt(receipt, plan, layer, receipt.sourceSha);
  verifyArchive(archive, layer);
  const stat = fs.statSync(archive);
  return {
    layer,
    archive: path.basename(archive),
    sizeBytes: stat.size,
    sha256: fileDigest(archive),
    cacheKey: plan.key,
    cachePaths: plan.paths,
    cachePlanDigest: plan.planDigest,
    compatibilityDigest: plan.compatibilityDigest,
    receiptDigest: receipt.receiptDigest,
  };
}

export function sealAffectedNativeCachePayload({
  qualificationDir,
  output,
  partitionIndex,
  partitionCount,
  repository,
  runId,
  event,
  headSha,
  compilerArchive,
  dependencyArchive = '',
}) {
  const root = path.resolve(qualificationDir);
  const plan = verifyAffectedPlan(readJson(path.join(root, 'plan.json')));
  assert(plan.head === headSha, 'cache payload producer source drift');
  assert(event === 'merge_group', 'cache payload producer must be merge_group');
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    'cache payload repository is invalid',
  );
  assert(
    /^[1-9][0-9]*$/.test(String(runId)),
    'cache payload run id is invalid',
  );
  const partition = partitionAffectedNativePlan(
    plan,
    Number(partitionCount),
    Number(partitionIndex),
  );
  const compilerPlan = readJson(path.join(root, 'cache/compiler.plan.json'));
  const compilerReceipt = readJson(
    path.join(root, 'cache/compiler.receipt.json'),
  );
  verifyReceipt(compilerReceipt, compilerPlan, 'compiler', headSha);
  assert(
    compilerPlan.manifest.identity.planDigest ===
      affectedNativeCompilerPlanDigest(plan.planDigest, partition),
    'compiler cache plan is not bound to the exact execution partition',
  );
  const layers = [
    payloadLayer({
      layer: 'compiler',
      archive: path.resolve(compilerArchive),
      plan: compilerPlan,
      receipt: compilerReceipt,
    }),
  ];
  if (dependencyArchive) {
    assert(
      partition.index === 0,
      'only partition 0 may publish dependency cache data',
    );
    const dependencyPlan = readJson(
      path.join(root, 'cache/dependency.plan.json'),
    );
    const dependencyReceipt = readJson(
      path.join(root, 'cache/dependency.receipt.json'),
    );
    verifyReceipt(dependencyReceipt, dependencyPlan, 'dependency', headSha);
    assert(
      dependencyPlan.manifest.identity.planDigest === plan.planDigest,
      'dependency cache plan is not bound to the full affected plan',
    );
    layers.unshift(
      payloadLayer({
        layer: 'dependency',
        archive: path.resolve(dependencyArchive),
        plan: dependencyPlan,
        receipt: dependencyReceipt,
      }),
    );
  }
  const body = {
    schema: 'kungfu.affected-native-cache-payload/v1',
    sourceSha: headSha,
    planDigest: plan.planDigest,
    partition,
    producer: {
      repository,
      runId: Number(runId),
      event,
      headSha,
    },
    layers,
  };
  const payload = { ...body, payloadDigest: digest(body) };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(
    path.resolve(output),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return payload;
}

function findFiles(root, basename, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(target, basename, found);
    else if (entry.isFile() && entry.name === basename) found.push(target);
  }
  return found;
}

function verifyPayload(payload, manifestFile, expected) {
  assert(
    payload?.schema === 'kungfu.affected-native-cache-payload/v1',
    'unsupported cache payload schema',
  );
  const { payloadDigest, ...body } = payload;
  assert(payloadDigest === digest(body), 'cache payload digest drift');
  assert(payload.sourceSha === expected.headSha, 'cache payload source drift');
  assert(
    payload.producer?.headSha === expected.headSha,
    'cache producer head drift',
  );
  assert(
    payload.producer?.runId === expected.runId,
    'cache producer run drift',
  );
  assert(
    payload.producer?.repository === expected.repository,
    'cache producer repository drift',
  );
  assert(
    payload.producer?.event === 'merge_group',
    'cache producer event drift',
  );
  assert(
    DIGEST_RE.test(payload.planDigest || ''),
    'cache payload plan digest is invalid',
  );
  assert(
    payload.partition?.schema === 'kungfu.core-affected-native-partition/v1',
    'cache payload partition schema is invalid',
  );
  const root = path.dirname(manifestFile);
  for (const layer of payload.layers || []) {
    assert(
      ['dependency', 'compiler'].includes(layer.layer),
      'cache payload layer is invalid',
    );
    assert(
      path.basename(layer.archive || '') === layer.archive,
      'cache payload archive path is invalid',
    );
    const archive = path.join(root, layer.archive);
    assert(
      fs.statSync(archive).isFile(),
      `${layer.layer} cache payload archive is missing`,
    );
    assert(
      fs.statSync(archive).size === layer.sizeBytes,
      `${layer.layer} cache payload size drift`,
    );
    assert(
      fileDigest(archive) === layer.sha256,
      `${layer.layer} cache payload digest drift`,
    );
    assert(
      JSON.stringify(layer.cachePaths) ===
        JSON.stringify(LAYER_PATHS[layer.layer]),
      `${layer.layer} cache payload roots are outside the promotion authority`,
    );
    assert(
      DIGEST_RE.test(layer.cachePlanDigest || ''),
      `${layer.layer} cache plan digest is invalid`,
    );
    assert(
      DIGEST_RE.test(layer.compatibilityDigest || ''),
      `${layer.layer} compatibility digest is invalid`,
    );
    assert(
      DIGEST_RE.test(layer.receiptDigest || ''),
      `${layer.layer} receipt digest is invalid`,
    );
    verifyArchive(archive, layer.layer);
    layer.absoluteArchive = archive;
  }
  return payload;
}

export function createAffectedNativeCachePromotion({
  artifactsDir,
  expectedHeadSha,
  expectedRunId,
  expectedRepository,
}) {
  assert(
    SHA_RE.test(expectedHeadSha || ''),
    'expected promotion source is invalid',
  );
  assert(
    Number.isInteger(Number(expectedRunId)) && Number(expectedRunId) > 0,
    'expected promotion run id is invalid',
  );
  const manifestFiles = findFiles(
    path.resolve(artifactsDir),
    'payload.manifest.json',
  );
  assert(
    manifestFiles.length > 0,
    'no affected-native cache payload manifests found',
  );
  const expected = {
    headSha: expectedHeadSha,
    runId: Number(expectedRunId),
    repository: expectedRepository,
  };
  const payloads = manifestFiles.map((file) =>
    verifyPayload(readJson(file), file, expected),
  );
  const count = payloads[0].partition.count;
  assert(
    payloads.length === count,
    'cache payload partition set is incomplete',
  );
  assert(
    payloads.every(
      (payload) =>
        payload.partition.count === count &&
        payload.planDigest === payloads[0].planDigest &&
        payload.partition.coverageDigest ===
          payloads[0].partition.coverageDigest,
    ),
    'cache payload partition authority drift',
  );
  const indexes = payloads
    .map((payload) => payload.partition.index)
    .sort((left, right) => left - right);
  assert(
    indexes.every((index, position) => index === position),
    'cache payload partitions are missing or duplicated',
  );
  const compiler = payloads.map((payload) => {
    const layers = payload.layers.filter((layer) => layer.layer === 'compiler');
    assert(
      layers.length === 1,
      `partition ${payload.partition.index} compiler payload is not unique`,
    );
    return { ...layers[0], partitionIndex: payload.partition.index };
  });
  assert(
    compiler.every(
      (layer) => layer.compatibilityDigest === compiler[0].compatibilityDigest,
    ),
    'compiler cache compatibility drift across partitions',
  );
  const dependencies = payloads.flatMap((payload) =>
    payload.layers
      .filter((layer) => layer.layer === 'dependency')
      .map((layer) => ({ ...layer, partitionIndex: payload.partition.index })),
  );
  assert(
    dependencies.length === 1 && dependencies[0].partitionIndex === 0,
    'dependency cache payload must come uniquely from partition 0',
  );
  const body = {
    schema: 'kungfu.affected-native-cache-promotion/v1',
    sourceSha: expectedHeadSha,
    producerRunId: Number(expectedRunId),
    repository: expectedRepository,
    planDigest: payloads[0].planDigest,
    partitionCount: count,
    dependency: dependencies[0],
    compiler: {
      cacheKey: compiler.find((layer) => layer.partitionIndex === 0).cacheKey,
      cachePaths: LAYER_PATHS.compiler,
      compatibilityDigest: compiler[0].compatibilityDigest,
      archives: compiler
        .sort((left, right) => left.partitionIndex - right.partitionIndex)
        .map(({ absoluteArchive, partitionIndex, sha256, sizeBytes }) => ({
          archive: absoluteArchive,
          partitionIndex,
          sha256,
          sizeBytes,
        })),
    },
  };
  return { ...body, promotionDigest: digest(body) };
}

function parseArgs(argv) {
  const command = ['seal', 'promote'].includes(argv[0]) ? argv.shift() : '';
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    options[arg.slice(2)] = argv[++index];
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function writeGithubOutput(file, fields) {
  if (!file) return;
  const lines = Object.entries(fields).map(
    ([name, value]) => `${name}=${value}`,
  );
  fs.appendFileSync(path.resolve(file), `${lines.join('\n')}\n`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'seal') {
    sealAffectedNativeCachePayload({
      qualificationDir: required(options, 'qualification-dir'),
      output: required(options, 'output'),
      partitionIndex: Number(required(options, 'partition-index')),
      partitionCount: Number(required(options, 'partition-count')),
      repository: required(options, 'repository'),
      runId: required(options, 'run-id'),
      event: required(options, 'event'),
      headSha: required(options, 'head-sha'),
      compilerArchive: required(options, 'compiler-archive'),
      dependencyArchive: options['dependency-archive'] || '',
    });
    console.log(`[affected-native-cache] payload=${options.output}`);
    return;
  }
  if (command === 'promote') {
    const promotion = createAffectedNativeCachePromotion({
      artifactsDir: required(options, 'artifacts-dir'),
      expectedHeadSha: required(options, 'expected-head-sha'),
      expectedRunId: Number(required(options, 'expected-run-id')),
      expectedRepository: required(options, 'expected-repository'),
    });
    const output = required(options, 'output');
    fs.writeFileSync(
      path.resolve(output),
      `${JSON.stringify(promotion, null, 2)}\n`,
    );
    writeGithubOutput(options['github-output'], {
      'dependency-key': promotion.dependency.cacheKey,
      'compiler-key': promotion.compiler.cacheKey,
    });
    console.log(`[affected-native-cache] promotion=${output}`);
    return;
  }
  const plan = JSON.parse(
    fs.readFileSync(path.resolve(ROOT, required(options, 'plan')), 'utf8'),
  );
  const manifests = createAffectedNativeCacheManifests({ plan });
  const output = path.resolve(ROOT, required(options, 'output-dir'));
  fs.mkdirSync(output, { recursive: true });
  for (const [layer, manifest] of Object.entries(manifests)) {
    fs.writeFileSync(
      path.join(output, `${layer}.manifest.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  console.log(
    `[affected-native-cache] manifests=${path.relative(ROOT, output)}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`[affected-native-cache] ${error.message}`);
    process.exitCode = 1;
  }
}
