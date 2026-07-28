#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
const outcomes = [];

function option(name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return path.resolve(argv[index + 1]);
}

const reportPath = option('--report');
const packagedRoot = option('--packaged-root');
const skipCampaigns = argv.includes('--skip-campaigns');

function run(label, command, args, options = {}) {
  process.stdout.write(`[kfx-terminal] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      `${label} failed with exit ${result.status ?? result.signal}`,
    );
  }
  outcomes.push({ label, status: 'passed' });
  return options.capture ? result.stdout.trim() : '';
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fileRoot(relative) {
  return sha256(fs.readFileSync(path.join(root, relative)));
}

function treeRoot(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(directory, absolute).split(path.sep).join('/'),
          root: sha256(fs.readFileSync(absolute)),
        });
      }
    }
  };
  visit(directory);
  return sha256(JSON.stringify(files));
}

function git(args) {
  return run(`git ${args.join(' ')}`, 'git', args, { capture: true });
}

function trackedFiles(...roots) {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0)
    throw new Error('cannot enumerate qualification sources');
  return listed.stdout.split('\n').filter(Boolean);
}

function reverseScan() {
  const activeRoots = [
    'config',
    'extensions',
    'framework/api/src/capability',
    'framework/core/src/libkungfu/src/runtime/kfx',
    'framework/core/src/python/kungfu',
    'framework/gui/src',
    'framework/kfx/src',
    'framework/tui/src',
    'product',
  ];
  const forbidden = [
    {
      code: 'private-kfx-history-authority',
      pattern: /registry-history\.jsonl/u,
    },
    {
      code: 'retired-agent-work-lab-alias',
      pattern: new RegExp(
        `\\b${['Agent', 'Qualification', 'Lab'].join(' ')}\\b|\\b${[
          'qualification',
          'lab',
        ].join('[-_]')}\\b`,
        'u',
      ),
    },
    {
      code: 'caller-selected-first-party-authority',
      pattern: /\b(authorizeFirstParty|isFirstParty|KF_FIRST_PARTY)\b/u,
    },
  ];
  const violations = [];
  for (const relative of trackedFiles(...activeRoots)) {
    if (
      relative.includes('/tests/') ||
      relative.endsWith('.test.ts') ||
      relative.endsWith('.test.mjs') ||
      relative === 'framework/core/src/python/kungfu/rewind/first_party.py'
    ) {
      continue;
    }
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source))
        violations.push(`${rule.code}:${relative}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `active authority reverse scan failed:\n${violations.join('\n')}`,
  );
  for (const retired of [
    'framework/kfx/schema/first-party-manifest.schema.json',
    'framework/gui/scripts/gen-first-party-manifest.mjs',
    'framework/gui/src/main/first-party-manifest.ts',
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, retired)),
      false,
      `${retired} returned`,
    );
  }
  outcomes.push({ label: 'active authority reverse scan', status: 'passed' });
}

function manifestMatrix() {
  const manifests = trackedFiles('extensions')
    .filter((relative) => relative.endsWith('/kungfu.kfx.json'))
    .sort();
  assert.ok(manifests.length > 0, 'no KFX manifests were found');
  const forbiddenKeys = new Set([
    'firstParty',
    'productSystem',
    'systemAuthority',
    'supportsKFD',
    'trusted',
    'runtimeTier',
  ]);
  const inspect = (value, relative) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        forbiddenKeys.has(key),
        false,
        `${relative} declares authority-bearing ${key}`,
      );
      inspect(child, relative);
    }
  };
  for (const relative of manifests) {
    inspect(
      JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')),
      relative,
    );
    const transport = path.join(path.dirname(relative), 'package.json');
    if (fs.existsSync(path.join(root, transport))) {
      const payload = JSON.parse(
        fs.readFileSync(path.join(root, transport), 'utf8'),
      );
      assert.equal(
        Object.hasOwn(payload, 'kungfuConfig'),
        false,
        `${transport} claims KFX semantic authority`,
      );
    }
  }
  outcomes.push({
    label: `identity-neutral manifest matrix (${manifests.length})`,
    status: 'passed',
  });
  return manifests;
}

function findPackagedApp(directory) {
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) return candidate;
      if (entry.isDirectory()) queue.push(candidate);
    }
  }
  throw new Error(`no packaged macOS app found under ${directory}`);
}

function qualifyPackagedMac() {
  assert.equal(
    process.platform,
    'darwin',
    'packaged terminal campaign requires macOS',
  );
  const app = findPackagedApp(packagedRoot);
  const resources = path.join(app, 'Contents', 'Resources');
  for (const relative of [
    'cli',
    'kungfu',
    'tui',
    'extensions/agent-work-lab/kungfu.kfx.json',
    'extensions/agent-work-lab/experience/kungfu.kfx.json',
  ]) {
    assert.ok(
      fs.existsSync(path.join(resources, relative)),
      `packaged resource missing: ${relative}`,
    );
  }
  const disposable = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfx-terminal-'),
  );
  try {
    const runtime = path.join(resources, 'kungfu', 'kungfu');
    assert.ok(fs.existsSync(runtime), 'packaged Core CLI is missing');
    const env = {
      ...process.env,
      KF_HOME: path.join(disposable, 'home'),
      KF_CONFIG_HOME: path.join(disposable, 'config'),
      KF_RUNTIME_DIR: path.join(disposable, 'home', 'runtime'),
      KF_BUNDLED_EXTENSION_ROOT: path.join(resources, 'extensions'),
      KUNGFU_AGENT_WORK_LAB_OFFLINE: '1',
    };
    const catalog = JSON.parse(
      run(
        'packaged CLI Agent Work Lab catalog',
        runtime,
        ['agent-work-lab', 'catalog', '--json'],
        { capture: true, env },
      ),
    );
    assert.equal(catalog.schema, 'kungfu.agent-work-lab.catalog/v1');
    assert.equal(catalog.suite.id, 'kungfu.agent-work-lab');
    assert.deepEqual(
      catalog.suite.cases.map(({ id }) => id),
      ['offline-demo', 'same-agent', 'cross-agent'],
    );
    run(
      'packaged CLI first-run offline Agent Work Lab',
      runtime,
      ['agent-work-lab', 'demo', '--json'],
      { capture: true, env },
    );
    run(
      'packaged CLI existing-Work-first rerun',
      runtime,
      ['agent-work-lab', 'demo', '--json'],
      { capture: true, env },
    );
    outcomes.push({
      label: 'packaged GUI and TUI share the admitted Agent Work Lab Suite',
      status: 'passed',
    });
    return { appRoot: treeRoot(app), resourcesRoot: treeRoot(resources) };
  } finally {
    fs.rmSync(disposable, { recursive: true, force: true });
  }
}

if (!skipCampaigns) {
  run('native authority and adversarial campaigns', './shifu', [
    'test:native-kfx-admission',
  ]);
  run('Agent Work Lab Suite campaigns', './shifu', ['test:agent-work-lab']);
  run('Profile Suite public-contract campaigns', './shifu', [
    'test:kfx-profile-suite',
  ]);
}

reverseScan();
const manifests = manifestMatrix();
const packaged = packagedRoot ? qualifyPackagedMac() : null;
const report = {
  schema: 'kungfu.kfx-identity-neutral-terminal-qualification/v1',
  goal: '2026-07-28-kungfu-kfx-identity-neutral-terminal-qualification',
  supersedes: '2026-07-28-kungfu-kfx-agent-work-lab-terminal-qualification',
  sourceRevision: git(['rev-parse', 'HEAD']),
  sourceTree: git(['rev-parse', 'HEAD^{tree}']),
  platform: { os: process.platform, arch: process.arch },
  authority: {
    kfd: 'common-evaluation-standard-and-eligibility-only',
    passport: 'exact-artifact-evidence',
    warrant: 'purpose-bound-authorization',
    capabilityGrant: 'runtime-power-ceiling',
    productSystem: 'inert-assembly-and-distribution-metadata',
    identityAuthority: false,
    originAuthority: false,
  },
  evidenceRoots: {
    kfxContract: fileRoot('config/kungfu-kfx.contract.json'),
    nativeRuntime: fileRoot(
      'framework/core/src/libkungfu/src/runtime/kfx/native_registry.cpp',
    ),
    nativeCampaign: fileRoot(
      'framework/core/src/libkungfu/tests/native_kfx_contract_tests.cpp',
    ),
    agentWorkLabCatalog: fileRoot(
      'extensions/agent-work-lab/experience/catalog.json',
    ),
  },
  matrix: { manifestCount: manifests.length, outcomes, packaged },
};
report.reportRoot = sha256(JSON.stringify(report));

if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[kfx-terminal] report=${reportPath}\n`);
}
process.stdout.write(`[kfx-terminal] PASS reportRoot=${report.reportRoot}\n`);
