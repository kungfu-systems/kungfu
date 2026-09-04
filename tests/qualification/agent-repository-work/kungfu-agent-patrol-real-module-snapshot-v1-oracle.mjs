// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getRepositoryWorkFixture } from './fixture-catalog.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const MANIFEST_PATH = path.join(
  ROOT,
  'tests/qualification/agent-repository-work/kungfu-agent-patrol-real-module-snapshot-v1.manifest.json',
);
const REPORT_SCHEMA = 'kungfu.agent-repository-work.oracle-report/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_HEAD_PATTERN = /^[0-9a-f]{40}$/u;
const DEFAULT_FIXTURE = getRepositoryWorkFixture(
  'kungfu-agent-patrol-real-module-snapshot-v1',
);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function root(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function jsonRoot(value) {
  return root(JSON.stringify(canonical(value)));
}

function lineCount(value) {
  return value.toString('utf8').split('\n').length - 1;
}

function run(command, args, options = {}) {
  const environment = { ...process.env, ...(options.env || {}) };
  Reflect.deleteProperty(environment, 'NODE_TEST_CONTEXT');
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: environment,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || (options.encoding === null ? Buffer.alloc(0) : ''),
    stderr: result.stderr || (options.encoding === null ? Buffer.alloc(0) : ''),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (
    manifest.schema !== 'kungfu.agent-repository-snapshot-manifest/v1' ||
    manifest.id !== DEFAULT_FIXTURE.id ||
    manifest.source?.revisionPolicy !== 'exact-commit' ||
    manifest.source?.trackedRegularFilesOnly !== true ||
    !ROOT_PATTERN.test(manifest.treeRoot || '') ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.fileCount
  )
    throw new Error('real module snapshot manifest is invalid');
  const paths = manifest.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length)
    throw new Error('real module snapshot manifest paths must be unique');
  if (
    manifest.lineCount !==
    manifest.files.reduce((count, entry) => count + entry.lines, 0)
  )
    throw new Error('real module snapshot manifest line count is invalid');
  return manifest;
}

function trackedMode(repositoryRoot, sourceHead, relative) {
  const args = sourceHead
    ? ['ls-tree', sourceHead, '--', relative]
    : ['ls-files', '--stage', '--', relative];
  const result = run('git', args, { cwd: repositoryRoot });
  if (result.error || result.status !== 0)
    throw new Error(`cannot resolve tracked source path: ${relative}`);
  const pattern = sourceHead
    ? /^(100644|100755) blob [0-9a-f]+\t(.+)$/u
    : /^(100644|100755) [0-9a-f]+ 0\t(.+)$/u;
  const match = String(result.stdout).trimEnd().match(pattern);
  if (!match || match[2] !== relative)
    throw new Error(
      `snapshot source is not one tracked regular file: ${relative}`,
    );
  return match[1];
}

function sourceBytes(repositoryRoot, sourceHead, relative) {
  if (!sourceHead) return fs.readFileSync(path.join(repositoryRoot, relative));
  if (!SOURCE_HEAD_PATTERN.test(sourceHead))
    throw new Error('snapshot sourceHead must be an exact Git commit');
  const result = run('git', ['show', `${sourceHead}:${relative}`], {
    cwd: repositoryRoot,
    encoding: null,
  });
  if (result.error || result.status !== 0)
    throw new Error(`cannot read exact snapshot source path: ${relative}`);
  return result.stdout;
}

function sourceRows({ repositoryRoot, sourceHead, manifest }) {
  const rows = manifest.files.map((entry) => {
    const mode = trackedMode(repositoryRoot, sourceHead, entry.path);
    const content = sourceBytes(repositoryRoot, sourceHead, entry.path);
    const row = {
      path: entry.path,
      mode,
      bytes: content.length,
      lines: lineCount(content),
      root: root(content),
    };
    for (const field of ['mode', 'bytes', 'lines', 'root'])
      if (row[field] !== entry[field])
        throw new Error(
          `snapshot manifest ${field} mismatch for ${entry.path}`,
        );
    return { ...row, content };
  });
  const publicRows = rows.map(({ content, ...entry }) => entry);
  if (jsonRoot(publicRows) !== manifest.treeRoot)
    throw new Error('snapshot manifest tree root mismatch');
  return rows;
}

function normalizedRelative(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(workspace) {
  const rows = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizedRelative(path.relative(workspace, absolute));
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink())
        throw new Error(`snapshot workspace contains a symlink: ${relative}`);
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile())
        rows.push({
          path: relative,
          bytes: stats.size,
          root: root(fs.readFileSync(absolute)),
        });
      else throw new Error(`unsupported snapshot entry: ${relative}`);
    }
  }
  walk(workspace);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function replaceExactlyOnce(value, from, to, label) {
  const first = value.indexOf(from);
  if (first < 0 || value.indexOf(from, first + from.length) >= 0)
    throw new Error(`${label} must match exactly once`);
  return `${value.slice(0, first)}${to}${value.slice(first + from.length)}`;
}

function diffTrees(initial, current) {
  const initialMap = new Map(initial.map((row) => [row.path, row.root]));
  const currentMap = new Map(current.map((row) => [row.path, row.root]));
  return [...new Set([...initialMap.keys(), ...currentMap.keys()])]
    .filter((relative) => initialMap.get(relative) !== currentMap.get(relative))
    .sort();
}

function visibleSuite(workspace, fixture) {
  const [command, ...args] = fixture.verification.visibleCommand;
  return run(command, args, { cwd: workspace });
}

function hiddenSuite(workspace) {
  const classifyUrl = pathToFileURL(
    path.join(workspace, 'developer/agent-patrol/classify.mjs'),
  ).href;
  const source = `
import assert from 'node:assert/strict';
const { classifyReport } = await import(${JSON.stringify(classifyUrl)});
const image = 'ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:${'a'.repeat(64)}';
const model = 'qwen3-coder:30b-opencode-64k';
const sourceHead = '${'b'.repeat(40)}';
const report = (message) => ({
  schema: 'kungfu.agent-repository-work.report/v1',
  evidenceClass: 'bounded-experiment',
  passed: false,
  sourceHead,
  fixture: { id: 'kungfu-agent-patrol-real-module-snapshot-v1' },
  runtime: {
    provider: 'opencode',
    image,
    directExecutable: null,
    model,
    baseUrlRoot: 'sha256:${'c'.repeat(64)}',
    context: 65536,
  },
  sessions: { distinct: 0 },
  continuity: { priorTranscriptBytes: 0, humanRestatementCount: 0 },
  warrant: {},
  dimensions: {},
  nonClaims: {
    auditableDemo: true,
    agentWorkLab: true,
    releaseGate: true,
    publicClaim: true,
    modelRanking: true,
  },
  failure: {
    category: 'model-tool-runtime',
    message,
    outputRoot: 'sha256:${'d'.repeat(64)}',
  },
});
const options = { runnerExit: 1, sourceHead, model, image };
const first = classifyReport(
  report('provider attempt 24681357 stopped at /tmp/patrol-1357911'),
  options,
);
const second = classifyReport(
  report('provider attempt 97531864 stopped at /tmp/patrol-8642097'),
  options,
);
assert.equal(first.messageRoot, second.messageRoot);
assert.equal(first.findingIntent.findingId, second.findingIntent.findingId);
`;
  const oracleDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-real-snapshot-hidden.'),
  );
  try {
    return run(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: oracleDirectory,
    });
  } finally {
    fs.rmSync(oracleDirectory, { recursive: true, force: true });
  }
}

export function materializeRealModuleSnapshot(
  workspace,
  { fixture = DEFAULT_FIXTURE, repositoryRoot = ROOT, sourceHead = '' } = {},
) {
  if (fixture.kind !== 'real-module-snapshot')
    throw new Error('real module snapshot fixture kind is required');
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0)
    throw new Error('snapshot workspace must be new or empty');
  const manifest = loadManifest();
  const rows = sourceRows({ repositoryRoot, sourceHead, manifest });
  fs.mkdirSync(workspace, { recursive: true });
  for (const entry of rows) {
    const target = path.resolve(workspace, entry.path);
    if (!target.startsWith(`${path.resolve(workspace)}${path.sep}`))
      throw new Error(`snapshot path escapes workspace: ${entry.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, {
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
  }
  const mutation = manifest.mutation;
  if (
    mutation.path !== fixture.warrants.agentB.writablePaths[0] ||
    mutation.expectedOccurrences !== 1
  )
    throw new Error('snapshot mutation and writable Warrant disagree');
  const mutationPath = path.join(workspace, mutation.path);
  const pristine = fs.readFileSync(mutationPath, 'utf8');
  fs.writeFileSync(
    mutationPath,
    replaceExactlyOnce(
      pristine,
      mutation.from,
      mutation.to,
      'snapshot mutation',
    ),
  );
  return {
    manifest,
    sourceTreeRoot: manifest.treeRoot,
    initialTree: walkFiles(workspace),
  };
}

export function applyRealModuleSnapshotReferenceRepair(workspace) {
  const manifest = loadManifest();
  const mutation = manifest.mutation;
  const target = path.join(workspace, mutation.path);
  const mutated = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(
    target,
    replaceExactlyOnce(
      mutated,
      mutation.to,
      mutation.from,
      'snapshot reference repair',
    ),
  );
}

export function verifyRealModuleSnapshotWorkspace(
  workspace,
  {
    fixture = DEFAULT_FIXTURE,
    expectedInitialTree,
    requireModification = true,
    runHidden = true,
  } = {},
) {
  if (!Array.isArray(expectedInitialTree))
    throw new Error('snapshot verifier requires the exact initial tree');
  const manifest = loadManifest();
  const current = walkFiles(workspace);
  const changedPaths = diffTrees(expectedInitialTree, current);
  const allowed = new Set(fixture.warrants.agentB.writablePaths);
  const scopeViolations = changedPaths.filter(
    (relative) => !allowed.has(relative),
  );
  const visible = visibleSuite(workspace, fixture);
  const hidden = runHidden ? hiddenSuite(workspace) : null;
  const repairedRoot = current.find(
    ({ path: relative }) => relative === manifest.mutation.path,
  )?.root;
  const pristineRoot = manifest.files.find(
    ({ path: relative }) => relative === manifest.mutation.path,
  )?.root;
  const passed =
    scopeViolations.length === 0 &&
    (!requireModification || changedPaths.length > 0) &&
    repairedRoot === pristineRoot &&
    visible.status === 0 &&
    (!hidden || hidden.status === 0);
  const report = {
    schema: REPORT_SCHEMA,
    fixtureId: fixture.id,
    passed,
    authoritative: true,
    verifierLocation: 'outside-agent-workspace',
    sourceTreeRoot: manifest.treeRoot,
    workspaceTreeRoot: jsonRoot(current),
    initialTreeRoot: jsonRoot(expectedInitialTree),
    changedPaths,
    allowedWritablePaths: [...allowed].sort(),
    scopeViolations,
    checks: {
      modificationRequired: !requireModification || changedPaths.length > 0,
      scope: scopeViolations.length === 0,
      referenceRoot: repairedRoot === pristineRoot,
      visible: {
        passed: visible.status === 0,
        status: visible.status,
        signal: visible.signal,
        error: visible.error,
        outputRoot: root(`${visible.stdout}\n${visible.stderr}`),
      },
      hidden: hidden
        ? {
            passed: hidden.status === 0,
            status: hidden.status,
            signal: hidden.signal,
            error: hidden.error,
            outputRoot: root(`${hidden.stdout}\n${hidden.stderr}`),
          }
        : null,
    },
  };
  report.reportRoot = jsonRoot(report);
  return report;
}

export function qualifySeededRealModuleSnapshot(options = {}) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-real-snapshot-seeded.'),
  );
  try {
    const materialized = materializeRealModuleSnapshot(workspace, options);
    const visible = visibleSuite(workspace, options.fixture || DEFAULT_FIXTURE);
    const combined = `${visible.stdout}\n${visible.stderr}`;
    return {
      schema: 'kungfu.agent-repository-work.seeded-defect-report/v1',
      passed: visible.status !== 0,
      expectedFailures: [
        ...(options.fixture || DEFAULT_FIXTURE).investigation.expectedFailures,
      ],
      sourceTreeRoot: materialized.sourceTreeRoot,
      status: visible.status,
      outputRoot: root(combined),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export function qualifyReferenceRealModuleSnapshot(options = {}) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-real-snapshot-reference.'),
  );
  try {
    const materialized = materializeRealModuleSnapshot(workspace, options);
    applyRealModuleSnapshotReferenceRepair(workspace);
    return verifyRealModuleSnapshotWorkspace(workspace, {
      fixture: options.fixture || DEFAULT_FIXTURE,
      expectedInitialTree: materialized.initialTree,
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
