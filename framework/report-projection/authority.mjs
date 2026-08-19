#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const INVENTORY_PATH = 'framework/report-projection/authority.json';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

function canonical(value) {
  return Buffer.from(JSON.stringify(ordered(value)));
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : canonical(value))
    .digest('hex')}`;
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function git(...args) {
  return run('git', args).trim();
}

function fileBinding(relative) {
  return {
    path: relative,
    root: digest(fs.readFileSync(path.join(ROOT, relative))),
  };
}

function aggregateBinding(paths) {
  const files = [...new Set(paths)].sort().map(fileBinding);
  return { files, root: digest(files) };
}

function reportRoot(report) {
  if (typeof report.reportRoot === 'string') {
    const body = Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== 'reportRoot'),
    );
    if (digest(body) !== report.reportRoot)
      throw new Error('generated report has an invalid embedded reportRoot');
    return report.reportRoot;
  }
  return digest(report);
}

function currentRevision() {
  return git('rev-parse', 'HEAD^{commit}');
}

function ensureExactCheckout(inventory) {
  if (!inventory.reports.length)
    throw new Error('report authority inventory is empty');
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all');
  if (dirty)
    throw new Error(
      'authority inputs differ from HEAD; commit the candidate before generating an exact-revision projection',
    );
}

function generateRawReport(id) {
  if (id === 'abstraction-integrity') {
    const python =
      process.env.KUNGFU_PYTHON_STRUCTURE_PYTHON ||
      (process.platform === 'win32' ? 'python' : 'python3');
    return JSON.parse(
      run(python, ['scripts/check-python-structure.py', '--emit-report']),
    );
  }
  if (id === 'semantic-amplification')
    return JSON.parse(
      run(process.execPath, [
        'framework/maintainability/semantic-amplification.mjs',
        '--json',
      ]),
    );
  if (id === 'function-risk')
    return JSON.parse(
      run(process.execPath, [
        'framework/maintainability/function-risk.mjs',
        '--json',
      ]),
    );
  throw new Error(`unsupported generated report '${id}'`);
}

function baselineBinding(definition) {
  if (definition.baseline.kind === 'file')
    return { kind: 'file', ...fileBinding(definition.baseline.path) };
  const manifest = readJson(definition.policyPaths[0]);
  const ref = manifest[definition.baseline.manifestField];
  const revision = git('rev-parse', `${ref}^{commit}`);
  return {
    kind: 'git-revision',
    ref,
    revision,
    root: digest({ ref, revision }),
  };
}

function authorityBinding(definition) {
  const generator = aggregateBinding([
    definition.generator.path,
    ...(definition.generatorDependencyPaths || []),
  ]);
  const policy = aggregateBinding(definition.policyPaths);
  const baseline = baselineBinding(definition);
  return {
    generator,
    policy,
    baseline,
    authorityRoot: digest({ generator, policy, baseline }),
  };
}

function verifyAuthorityBinding(receipt, expected) {
  for (const key of ['generator', 'policy', 'baseline', 'authorityRoot'])
    if (
      JSON.stringify(ordered(receipt[key])) !==
      JSON.stringify(ordered(expected[key]))
    )
      throw new Error(`${key} binding mismatch for ${receipt.reportId}`);
  return true;
}

function writeImmutable(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(bytes))
      throw new Error(`content-address collision at ${target}`);
    return;
  }
  fs.writeFileSync(target, bytes, { flag: 'wx' });
}

function receiptDocument(definition, report, artifactPath, sourceRevision) {
  const { generator, policy, baseline, authorityRoot } =
    authorityBinding(definition);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const body = {
    schema: 'kungfu.generated-report-receipt/v1',
    reportId: definition.id,
    reportSchema: definition.reportSchema,
    sourceRevision,
    sourceRoot: report.sourceRoot,
    reportRoot: reportRoot(report),
    artifactRoot: digest(reportBytes),
    artifactPath,
    artifactBytes: reportBytes.length,
    generator,
    policy,
    baseline,
    authorityRoot,
  };
  return { reportBytes, receipt: { ...body, receiptRoot: digest(body) } };
}

function verifyReceipt(receipt, report, options = {}) {
  const body = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptRoot'),
  );
  if (digest(body) !== receipt.receiptRoot)
    throw new Error(`invalid receipt root for ${receipt.reportId}`);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (digest(reportBytes) !== receipt.artifactRoot)
    throw new Error(`artifact root mismatch for ${receipt.reportId}`);
  if (reportRoot(report) !== receipt.reportRoot)
    throw new Error(`report root mismatch for ${receipt.reportId}`);
  if (report.sourceRoot !== receipt.sourceRoot)
    throw new Error(`source root mismatch for ${receipt.reportId}`);
  if (report.schema !== receipt.reportSchema)
    throw new Error(`report schema mismatch for ${receipt.reportId}`);
  if (report.sourceRevision !== receipt.sourceRevision)
    throw new Error(`report source revision mismatch for ${receipt.reportId}`);
  if (reportBytes.length !== receipt.artifactBytes)
    throw new Error(`artifact byte count mismatch for ${receipt.reportId}`);
  const expectedArtifactPath = `reports/${receipt.reportId}/${receipt.artifactRoot.slice(7)}.json`;
  if (receipt.artifactPath !== expectedArtifactPath)
    throw new Error(`content-addressed path mismatch for ${receipt.reportId}`);
  if (options.authority) verifyAuthorityBinding(receipt, options.authority);
  if (!options.historical && currentRevision() !== receipt.sourceRevision)
    throw new Error(`source revision mismatch for ${receipt.reportId}`);
  return true;
}

function generate(output, projectionKind) {
  const inventory = readJson(INVENTORY_PATH);
  ensureExactCheckout(inventory);
  const sourceRevision = currentRevision();
  const receipts = [];
  for (const definition of inventory.reports) {
    const report = generateRawReport(definition.id);
    const temporaryPath = `${definition.id}.json`;
    const provisional = receiptDocument(
      definition,
      report,
      temporaryPath,
      sourceRevision,
    );
    const artifactPath = `reports/${definition.id}/${provisional.receipt.artifactRoot.slice(7)}.json`;
    const { reportBytes, receipt } = receiptDocument(
      definition,
      report,
      artifactPath,
      sourceRevision,
    );
    const receiptPath = `receipts/${receipt.receiptRoot.slice(7)}.json`;
    writeImmutable(path.join(output, artifactPath), reportBytes);
    writeImmutable(
      path.join(output, receiptPath),
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    );
    receipts.push({
      reportId: definition.id,
      receiptPath,
      receiptRoot: receipt.receiptRoot,
    });
  }
  const body = {
    schema: 'kungfu.generated-report-bundle/v1',
    projectionKind,
    sourceRevision,
    inventoryPath: INVENTORY_PATH,
    inventoryRoot: digest(inventory),
    receipts,
  };
  const bundle = { ...body, bundleRoot: digest(body) };
  const bundlePath = path.join(output, 'bundle.json');
  writeImmutable(
    bundlePath,
    Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`),
  );
  verifyBundle(bundlePath);
  return bundle;
}

function resolveArtifact(bundleDirectory, relative) {
  const absolute = path.resolve(bundleDirectory, relative);
  if (!absolute.startsWith(`${path.resolve(bundleDirectory)}${path.sep}`))
    throw new Error(`artifact path escapes bundle: ${relative}`);
  return absolute;
}

function verifyBundle(bundlePath, options = {}) {
  const absoluteBundle = path.resolve(bundlePath);
  const bundleDirectory = path.dirname(absoluteBundle);
  const bundle = JSON.parse(fs.readFileSync(absoluteBundle, 'utf8'));
  const body = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'bundleRoot'),
  );
  if (digest(body) !== bundle.bundleRoot)
    throw new Error('invalid generated report bundle root');
  const seen = new Set();
  for (const pointer of bundle.receipts) {
    if (seen.has(pointer.reportId))
      throw new Error(`duplicate report receipt '${pointer.reportId}'`);
    seen.add(pointer.reportId);
  }
  let definitions = new Map();
  if (!options.historical) {
    if (bundle.inventoryPath !== INVENTORY_PATH)
      throw new Error('current bundle uses an unknown authority inventory');
    const inventory = readJson(INVENTORY_PATH);
    if (digest(inventory) !== bundle.inventoryRoot)
      throw new Error('authority inventory root mismatch');
    definitions = new Map(
      inventory.reports.map((definition) => [definition.id, definition]),
    );
    if (
      JSON.stringify([...definitions.keys()].sort()) !==
      JSON.stringify([...seen].sort())
    )
      throw new Error('bundle report set differs from authority inventory');
  }
  for (const pointer of bundle.receipts) {
    const receipt = JSON.parse(
      fs.readFileSync(
        resolveArtifact(bundleDirectory, pointer.receiptPath),
        'utf8',
      ),
    );
    if (receipt.receiptRoot !== pointer.receiptRoot)
      throw new Error(`receipt pointer mismatch for ${pointer.reportId}`);
    const report = JSON.parse(
      fs.readFileSync(
        resolveArtifact(bundleDirectory, receipt.artifactPath),
        'utf8',
      ),
    );
    const definition = definitions.get(pointer.reportId);
    if (!options.historical && !definition)
      throw new Error(`unknown current report '${pointer.reportId}'`);
    verifyReceipt(receipt, report, {
      ...options,
      authority: definition ? authorityBinding(definition) : null,
    });
  }
  return bundle;
}

function projectorDecision(expectedRevision, protectedHead) {
  if (!/^[0-9a-f]{40}$/.test(expectedRevision))
    throw new Error('expected revision must be a full commit SHA');
  if (!/^[0-9a-f]{40}$/.test(protectedHead))
    throw new Error('protected head must be a full commit SHA');
  return expectedRevision === protectedHead ? 'publish' : 'discard-stale';
}

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const value = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] || '' : '';
  };
  return {
    command,
    output: value('--output'),
    bundle: value('--bundle'),
    projectionKind: value('--projection-kind') || 'candidate',
    historical: rest.includes('--historical'),
    expectedRevision: value('--expected-revision'),
    protectedHead: value('--protected-head'),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'generate') {
    if (!options.output) throw new Error('generate requires --output');
    const bundle = generate(
      path.resolve(options.output),
      options.projectionKind,
    );
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return;
  }
  if (options.command === 'verify') {
    if (!options.bundle) throw new Error('verify requires --bundle');
    const bundle = verifyBundle(options.bundle, {
      historical: options.historical,
    });
    process.stdout.write(
      `verified ${bundle.receipts.length} reports at ${bundle.sourceRevision}\n`,
    );
    return;
  }
  if (options.command === 'projector-decision') {
    process.stdout.write(
      `${projectorDecision(options.expectedRevision, options.protectedHead)}\n`,
    );
    return;
  }
  throw new Error(
    'usage: report-projection-authority.mjs generate|verify|projector-decision',
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `report-projection-authority: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export {
  canonical,
  digest,
  verifyAuthorityBinding,
  projectorDecision,
  receiptDocument,
  reportRoot,
  verifyBundle,
  verifyReceipt,
};
