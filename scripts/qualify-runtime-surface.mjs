#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REQUIRED_ROWS = [
  'assignment-capture-installed',
  'source-build-test-source',
  'portable-bundle-installed',
  'dogfood-actual-surface',
  'context-hybrid',
  'seal-installed',
];
const ROW_CONTRACT = {
  'assignment-capture-installed': {
    consumer: 'kungfu.work.capture',
    operations: [['assignment.capture', 'installed-product']],
  },
  'source-build-test-source': {
    consumer: 'shifu.build-test',
    operations: [
      ['source.build', 'source-checkout'],
      ['source.test', 'source-checkout'],
    ],
  },
  'portable-bundle-installed': {
    consumer: 'kungfu.agent.docs.verify',
    operations: [['portable-bundle.consume', 'installed-product']],
  },
  'dogfood-actual-surface': {
    consumer: 'kungfu.dogfood.capture',
    operations: [['dogfood.capture', null]],
  },
  'context-hybrid': {
    consumer: 'atlas.xinfa.context',
    operations: [['context.consume', 'hybrid-boundary']],
    requiredObservers: ['kungfu.tui.runtime-surface'],
  },
  'seal-installed': {
    consumer: 'kungfu.work.verify-seal',
    operations: [['assignment.seal-verify', 'installed-product']],
  },
};

function fail(message) {
  throw new Error(message);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fileRoot(file) {
  return digest(fs.readFileSync(file));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function valueRoot(value) {
  return digest(Buffer.from(JSON.stringify(canonical(value))));
}

export function consumerEvidence({
  rowId,
  consumer,
  output,
  receipts,
  observers = [],
}) {
  if (!rowId || !consumer || output === undefined || !receipts.length)
    fail('row, consumer, probe output, and at least one receipt are required');
  const expected = ROW_CONTRACT[rowId];
  if (
    !expected ||
    consumer !== expected.consumer ||
    receipts.length !== expected.operations.length
  )
    fail(`consumer evidence contract is invalid for ${rowId}`);
  assertConsumerOutput({ rowId, output, receipts });
  const probe = {
    schema: 'kungfu.runtime-surface-consumer-probe/v1',
    ok: true,
    output,
    outputRoot: valueRoot(output),
    observers: [...new Set(observers)].sort(),
  };
  const body = {
    schema: 'kungfu.runtime-surface-consumer-evidence/v1',
    rowId,
    consumer,
    probe,
    receipts,
  };
  return { ...body, evidenceRoot: valueRoot(body) };
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function outputIsSuccessful({
  rowId,
  output,
  receipts,
  authorityRoots,
  sourceCandidate,
  installedCandidate,
  hybridCandidate,
}) {
  if (!isObject(output)) return false;
  const receipt = receipts[0];
  const receiptAuthority = receipt?.authorityRoots;
  const expectedAuthority = authorityRoots || receiptAuthority;
  const source = sourceCandidate?.source || receipt?.source;
  const installedBundle = installedCandidate?.bundleRoot || receipt?.bundleRoot;
  switch (rowId) {
    case 'assignment-capture-installed':
      return (
        output.schema === 'kungfu.assignment-capture.response/v1' &&
        ['captured', 'already-present'].includes(output.status) &&
        output.authority === 'capture-material-only' &&
        output.admitted === false &&
        output.claimed === false &&
        ROOT_PATTERN.test(output.receiptRoot || '') &&
        output.requestRoot === receiptAuthority?.assignmentRequestRoot
      );
    case 'source-build-test-source':
      return (
        output.schema === 'kungfu.runtime-surface.source-build-test-probe/v1' &&
        output.ok === true &&
        output.head === source?.commit &&
        output.tree === source?.tree &&
        output.buildInfo?.git?.revision === source?.commit &&
        output.buildInfo?.git?.pristine === true &&
        ['sourceCheck', 'rebuild', 'check'].every(
          (key) =>
            output[key]?.ok === true &&
            ROOT_PATTERN.test(output[key]?.logRoot || ''),
        ) &&
        sameCanonicalValue(
          output.candidate?.authorityRoots,
          expectedAuthority,
        ) &&
        output.candidate?.head === source?.commit &&
        output.candidate?.tree ===
          String(source?.tree || '').replace(/^git:/u, '') &&
        (!installedCandidate ||
          (output.candidate?.executableRoot ===
            installedCandidate.executable?.digest &&
            output.candidate?.bundleRoot === installedBundle))
      );
    case 'portable-bundle-installed':
      return (
        output.schema === 'kungfu.documentation-pack-verification/v1' &&
        output.valid === true &&
        output.readOnly === true &&
        Array.isArray(output.diagnostics) &&
        output.diagnostics.length === 0 &&
        ROOT_PATTERN.test(output.receiptRoot || '') &&
        output.bundleRoot === receipt?.bundleRoot &&
        output.bundleRoot === installedBundle
      );
    case 'dogfood-actual-surface':
      return (
        output.schema ===
          'kungfu.dev-gate-latency-patrol.dogfood-capture-receipt/v1' &&
        ['captured', 'deduplicated'].includes(output.status) &&
        output.issueAdmitted === false &&
        Array.isArray(output.receipts) &&
        output.receipts.length > 0 &&
        output.receipts.every(
          (entry) =>
            ['captured', 'already-present'].includes(entry?.status) &&
            ROOT_PATTERN.test(entry?.findingRoot || '') &&
            sameCanonicalValue(entry?.runtimeReceipt, receipt) &&
            entry?.runtimeVerification?.ok === true &&
            entry.runtimeVerification.receiptRoot === receipt?.receiptRoot,
        )
      );
    case 'context-hybrid': {
      const context = output.context;
      const target = context?.route_scope?.target_repository;
      const observation = output.tui?.runtimeSurface;
      return (
        output.schema === 'atlas.xinfa-context-consumer-probe/v1' &&
        output.ok === true &&
        context?.schema === 'atlas.xinfa-context-envelope/v1' &&
        context.status === 'complete' &&
        context.authority === 'projection-only' &&
        context.source_cut?.assignment_request_root ===
          receiptAuthority?.assignmentRequestRoot &&
        target?.verified === true &&
        target.runtime_surface === 'hybrid-boundary' &&
        target.git_head === source?.commit &&
        target.git_tree === source?.tree &&
        target.project_root === receipt?.bundleRoot &&
        target.runtime_receipt_root === receipt?.receiptRoot &&
        sameCanonicalValue(target.runtime_receipt, receipt) &&
        observation?.receiptRoot === receipt?.receiptRoot &&
        observation.runtimeSurface === 'hybrid-boundary' &&
        observation.operationId === 'context.consume' &&
        observation.fallbackUsed === false
      );
    }
    case 'seal-installed':
      return (
        output.schema ===
          'kungfu.assignment-orchestration.seal-verification/v1' &&
        output.ok === true &&
        ROOT_PATTERN.test(output.state_root || '') &&
        typeof output.phase === 'string' &&
        output.phase.length > 0 &&
        Array.isArray(output.next_actions) &&
        output.next_actions.length === 0
      );
    default:
      return false;
  }
}

function assertConsumerOutput(context) {
  if (!outputIsSuccessful(context))
    fail(`consumer probe output is not successful for ${context.rowId}`);
}

function invoke(command, args, { json = true } = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    fail(
      `${[...command, ...args].join(' ')} failed (exit=${result.status}): ${String(
        result.stderr || result.stdout || '',
      ).trim()}`,
    );
  if (!json) return String(result.stdout || '').trim();
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('command did not return one JSON object');
    return value;
  } catch (error) {
    fail(`command did not return JSON: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = {
    output: '',
    assignmentRoot: null,
    workDefinitionRoot: null,
    workRoot: null,
    consumerEvidence: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    if (value === '--output') options.output = argv[++index] || '';
    else if (value === '--assignment-root')
      options.assignmentRoot = argv[++index] || null;
    else if (value === '--work-definition-root')
      options.workDefinitionRoot = argv[++index] || null;
    else if (value === '--work-root') options.workRoot = argv[++index] || null;
    else if (value === '--consumer-evidence') {
      const binding = argv[++index] || '';
      const separator = binding.indexOf('=');
      const row = separator > 0 ? binding.slice(0, separator) : '';
      const file = separator > 0 ? binding.slice(separator + 1) : '';
      if (!REQUIRED_ROWS.includes(row) || !file)
        fail('--consumer-evidence must be <required-row>=<json-file>');
      if (options.consumerEvidence[row])
        fail(`duplicate consumer evidence for ${row}`);
      options.consumerEvidence[row] = path.resolve(file);
    } else fail(`unknown argument: ${value}`);
  }
  if (!options.output) fail('--output is required');
  for (const [key, value] of Object.entries(options))
    if (
      !['output', 'consumerEvidence'].includes(key) &&
      value !== null &&
      !ROOT_PATTERN.test(value)
    )
      fail(
        `--${key.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} must be sha256 rooted`,
      );
  for (const row of REQUIRED_ROWS)
    if (!options.consumerEvidence[row])
      fail(`--consumer-evidence ${row}=<json-file> is required`);
  return options;
}

function parseConsumerEvidenceArgs(argv) {
  const options = {
    row: '',
    consumer: '',
    probeOutput: '',
    receipts: [],
    observers: [],
    output: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--row') options.row = argv[++index] || '';
    else if (arg === '--consumer') options.consumer = argv[++index] || '';
    else if (arg === '--probe-output')
      options.probeOutput = argv[++index] || '';
    else if (arg === '--receipt') options.receipts.push(argv[++index] || '');
    else if (arg === '--observer') options.observers.push(argv[++index] || '');
    else if (arg === '--output') options.output = argv[++index] || '';
    else fail(`unknown consumer-evidence argument: ${arg}`);
  }
  for (const field of ['row', 'consumer', 'probeOutput', 'output'])
    if (!options[field])
      fail(
        `--${field.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} is required`,
      );
  if (!options.receipts.length) fail('--receipt is required');
  return options;
}

function readObject(file, label) {
  const value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must contain one JSON object`);
  return value;
}

function writeConsumerEvidence(argv) {
  const options = parseConsumerEvidenceArgs(argv);
  const evidence = consumerEvidence({
    rowId: options.row,
    consumer: options.consumer,
    output: readObject(options.probeOutput, 'probe output'),
    receipts: options.receipts.map((file) => readObject(file, 'receipt')),
    observers: options.observers,
  });
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
  });
  return {
    schema: evidence.schema,
    rowId: evidence.rowId,
    evidenceRoot: evidence.evidenceRoot,
    output,
  };
}

export function verifyConsumerEvidence({
  rowId,
  file,
  sourceCommand,
  installedCommand,
  authorityRoots,
  sourceCandidate,
  installedCandidate,
  hybridCandidate,
  invokeCommand = invoke,
}) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value?.schema !== 'kungfu.runtime-surface-consumer-evidence/v1' ||
    value.rowId !== rowId ||
    value.consumer !== ROW_CONTRACT[rowId].consumer ||
    value.probe?.ok !== true ||
    value.probe?.schema !== 'kungfu.runtime-surface-consumer-probe/v1' ||
    !Object.hasOwn(value.probe, 'output') ||
    !ROOT_PATTERN.test(value.probe?.outputRoot || '') ||
    !Array.isArray(value.receipts)
  )
    fail(`consumer evidence is invalid for ${rowId}`);
  if (value.probe.outputRoot !== valueRoot(value.probe.output))
    fail(`consumer probe output root mismatch for ${rowId}`);
  const declaredRoot = value.evidenceRoot;
  const body = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'evidenceRoot'),
  );
  if (declaredRoot !== valueRoot(body))
    fail(`consumer evidence root mismatch for ${rowId}`);
  const expected = ROW_CONTRACT[rowId];
  if (value.receipts.length !== expected.operations.length)
    fail(`consumer receipt count mismatch for ${rowId}`);
  for (const observer of expected.requiredObservers || [])
    if (!(value.probe.observers || []).includes(observer))
      fail(`consumer evidence ${rowId} is missing observer ${observer}`);

  assertConsumerOutput({
    rowId,
    output: value.probe.output,
    receipts: value.receipts,
    authorityRoots,
    sourceCandidate,
    installedCandidate,
    hybridCandidate,
  });

  const candidateBySurface = {
    'source-checkout': sourceCandidate,
    'installed-product': installedCandidate,
    'hybrid-boundary': hybridCandidate,
  };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `kungfu-runtime-consumer-${rowId}-`),
  );
  try {
    value.receipts.forEach((receipt, index) => {
      const [operation, requiredSurface] = expected.operations[index];
      if (
        receipt?.schema !== 'kungfu.runtime-surface-receipt/v1' ||
        receipt.operationId !== operation ||
        (requiredSurface && receipt.runtimeSurface !== requiredSurface) ||
        !sameCanonicalValue(receipt.authorityRoots, authorityRoots)
      )
        fail(`consumer receipt ${index} contradicts ${rowId}`);
      const candidate = candidateBySurface[receipt.runtimeSurface];
      if (!candidate) fail(`consumer receipt ${index} has unknown surface`);
      for (const coordinate of ['executable', 'source'])
        if (!sameCanonicalValue(receipt[coordinate], candidate[coordinate]))
          fail(`consumer receipt ${index} has stale ${coordinate}`);
      if (
        receipt.runtimeSurface === 'hybrid-boundary'
          ? !ROOT_PATTERN.test(receipt.bundleRoot || '')
          : !sameCanonicalValue(receipt.bundleRoot, candidate.bundleRoot)
      )
        fail(`consumer receipt ${index} has stale bundleRoot`);
      const receiptPath = path.join(directory, `${index}-receipt.json`);
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const command =
        receipt.runtimeSurface === 'source-checkout'
          ? sourceCommand
          : installedCommand;
      const verification = invokeCommand(command, [
        'runtime',
        'surface',
        'verify',
        receiptPath,
        '--json',
      ]);
      if (
        verification.ok !== true ||
        verification.receiptRoot !== receipt.receiptRoot
      )
        fail(`consumer receipt verification failed for ${rowId}`);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return value;
}

function candidateEvidence({
  head,
  tree,
  buildInfoPath,
  shifu,
  installed,
  docs,
}) {
  const source = {
    schema: 'kungfu.runtime-surface-candidate-evidence/v1',
    surface: 'source-checkout',
    head,
    tree,
    buildInfoRoot: fileRoot(buildInfoPath),
    shifuRoot: fileRoot(shifu),
  };
  const product = {
    schema: 'kungfu.runtime-surface-candidate-evidence/v1',
    surface: 'installed-product',
    executableRoot: fileRoot(installed),
    bundleRoot: docs.bundleRoot,
    documentationReceiptRoot: docs.receiptRoot,
  };
  return {
    source: { ...source, evidenceRoot: valueRoot(source) },
    installed: { ...product, evidenceRoot: valueRoot(product) },
  };
}

function qualify(options) {
  const shifu = path.join(ROOT, 'shifu');
  const buildInfoPath = path.join(
    ROOT,
    'framework/core/dist/kungfu/kungfubuildinfo.json',
  );
  const installed = path.join(
    ROOT,
    'framework/core/dist/kungfu',
    process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  for (const file of [shifu, buildInfoPath, installed])
    if (!fs.existsSync(file))
      fail(`qualification prerequisite is missing: ${file}`);
  const git = (...args) => invoke(['git'], args, { json: false });
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  if (git('status', '--porcelain', '--untracked-files=no'))
    fail(
      'runtime surface qualification requires a clean tracked source checkout',
    );
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  if (buildInfo.git?.revision !== head || buildInfo.git?.pristine !== true)
    fail('assembled product does not match the clean source checkout');

  const sourceCommand = [shifu, 'kungfu'];
  const installedCommand = [installed];
  const docs = invoke(installedCommand, [
    'agent',
    'docs',
    '--verify',
    '--json',
  ]);
  if (docs.valid !== true || !ROOT_PATTERN.test(docs.bundleRoot || ''))
    fail('assembled product has no valid rooted Portable Atlas Bundle');
  const evidence = candidateEvidence({
    head,
    tree,
    buildInfoPath,
    shifu,
    installed,
    docs,
  });
  const sourceVersion = `${buildInfo.version}+source`;
  const installedVersion = invoke(installedCommand, ['--version'], {
    json: false,
  });
  const sourceCandidate = {
    providerId: 'source-shifu',
    surface: 'source-checkout',
    capabilities: [
      'dogfood.capture',
      'runtime.provenance',
      'source.build',
      'source.test',
    ],
    executable: {
      path: shifu,
      digest: fileRoot(shifu),
      kind: 'source-shifu',
      version: sourceVersion,
    },
    source: { commit: head, tree: `git:${tree}`, worktree: ROOT },
    bundleRoot: null,
    qualification: {
      state: 'source-qualified',
      evidenceRoots: [evidence.source.evidenceRoot],
    },
  };
  const installedCandidate = {
    providerId: 'installed-kungfu',
    surface: 'installed-product',
    capabilities: [
      'assignment.capture',
      'assignment.seal-verify',
      'bundle.read',
      'dogfood.capture',
      'runtime.provenance',
    ],
    executable: {
      path: installed,
      digest: fileRoot(installed),
      kind: 'installed-kungfu',
      version: installedVersion,
    },
    source: { commit: null, tree: null, worktree: null },
    bundleRoot: docs.bundleRoot,
    qualification: {
      state: 'qualified',
      evidenceRoots: [evidence.installed.evidenceRoot],
    },
  };
  const hybridCandidate = {
    providerId: 'atlas-kungfu-hybrid',
    surface: 'hybrid-boundary',
    capabilities: ['context.compose', 'dogfood.capture', 'runtime.provenance'],
    executable: {
      path: null,
      digest: null,
      kind: 'composed-boundary',
      version: null,
    },
    source: { commit: head, tree: `git:${tree}`, worktree: ROOT },
    bundleRoot: docs.bundleRoot,
    qualification: {
      state: 'source-qualified',
      evidenceRoots: [
        evidence.source.evidenceRoot,
        evidence.installed.evidenceRoot,
      ],
    },
  };
  const authorityRoots = {
    assignmentRequestRoot: options.assignmentRoot,
    workDefinitionRoot: options.workDefinitionRoot,
    workRoot: options.workRoot,
  };
  const rows = REQUIRED_ROWS.map((id) => {
    const consumerEvidence = verifyConsumerEvidence({
      rowId: id,
      file: options.consumerEvidence[id],
      sourceCommand,
      installedCommand,
      authorityRoots,
      sourceCandidate,
      installedCandidate,
      hybridCandidate,
    });
    return {
      id,
      receipts: consumerEvidence.receipts,
      consumerEvidence: {
        root: consumerEvidence.evidenceRoot,
        consumer: consumerEvidence.consumer,
        probe: consumerEvidence.probe,
      },
    };
  });
  const body = {
    schema: 'kungfu.runtime-surface-qualification/v1',
    status: 'passed',
    source: { commit: head, tree: `git:${tree}`, worktree: ROOT },
    product: {
      executable: installed,
      executableRoot: fileRoot(installed),
      version: installedVersion,
      bundleRoot: docs.bundleRoot,
      releaseQualified: docs.releaseQualified === true,
    },
    authorityRoots,
    candidateEvidence: evidence,
    rows,
  };
  return { ...body, reportRoot: valueRoot(body) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'consumer-evidence') {
      process.stdout.write(
        `${JSON.stringify(writeConsumerEvidence(process.argv.slice(3)))}\n`,
      );
      process.exit(0);
    }
    const options = parseArgs(process.argv.slice(2));
    const report = qualify(options);
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: report.schema,
          status: report.status,
          reportRoot: report.reportRoot,
          output,
          rows: report.rows.map((row) => row.id),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `runtime surface qualification failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
