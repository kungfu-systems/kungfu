#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTarGz,
  extractZip,
} from '../../../../product/scripts/archive.mjs';
import {
  sha256File,
  sha256Tree,
} from '../../../../product/scripts/compatibility.mjs';
import {
  cliArchiveBase,
  runInstalledCliSemanticSmoke,
  runInstalledKungfu,
} from '../../../../product/scripts/dist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const FIXTURE = path.join(HERE, 'semantic-fixture-v1.json');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    validateOnly: false,
    cliArchive: '',
    desktopDir: '',
    report: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--validate-only') options.validateOnly = true;
    else if (['--cli-archive', '--desktop-dir', '--report'].includes(arg)) {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a path`);
      options[
        arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      ] = path.resolve(argv[index]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: ./shifu layers:qualify:surfaces -- [--validate-only] [--cli-archive PATH --desktop-dir PATH] [--report PATH]',
      );
      process.exit(0);
    } else fail(`unknown argument '${arg}'`);
  }
  if (!options.validateOnly && (!options.cliArchive || !options.desktopDir)) {
    fail('exact qualification requires --cli-archive and --desktop-dir');
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceValidation() {
  const fixture = readJson(FIXTURE);
  if (fixture.schema !== 'kungfu.surface-qualification.fixture/v1')
    fail('unexpected surface fixture schema');
  const expectedSteps = [
    'init',
    'record',
    'query',
    'verify',
    'export',
    'agent_discovery',
  ];
  if (
    JSON.stringify(fixture.cli.required_steps) !== JSON.stringify(expectedSteps)
  )
    fail('CLI semantic steps drifted');
  const operations = fixture.gui.operations;
  if (
    operations.length !== 5 ||
    new Set(operations.map((row) => row.id)).size !== 5
  )
    fail('GUI operations must cover five unique semantics');
  for (const row of operations) {
    if (
      !row.capability.startsWith('storage.') ||
      !row.lower_expression.startsWith('kungfu storage ')
    )
      fail(`GUI operation ${row.id} lacks a stable lower expression`);
  }
  const storageSource = fs.readFileSync(
    path.join(ROOT, 'framework/api/src/capability/storage.ts'),
    'utf8',
  );
  const guiSource = fs.readFileSync(
    path.join(ROOT, 'extensions/system/status/src/view/index.tsx'),
    'utf8',
  );
  const guiManifest = readJson(
    path.join(ROOT, 'extensions/system/status/package.json'),
  );
  if (!guiManifest.kungfuConfig.config.view.capabilities.includes('storage'))
    fail('GUI status view does not declare storage capability');
  for (const row of operations) {
    const method = row.capability.split('.')[1];
    if (
      !storageSource.includes(`${method}:`) ||
      !guiSource.includes(`storage.${method}`)
    )
      fail(
        `GUI operation ${row.id} is not wired through the public capability`,
      );
  }
  return fixture;
}

function findOne(root, basename) {
  const matches = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === basename) matches.push(full);
    }
  };
  visit(root);
  if (matches.length !== 1)
    fail(`expected one ${basename} under ${root}, found ${matches.length}`);
  return matches[0];
}

function directoryBytes(root) {
  let total = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  visit(root);
  return total;
}

function exactQualification(options, fixture) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-surface-qualification-'),
  );
  try {
    if (options.cliArchive.endsWith('.zip'))
      extractZip({ archiveFile: options.cliArchive, targetDir: temp });
    else extractTarGz({ archiveFile: options.cliArchive, targetDir: temp });
    const expectedRoot = path.join(
      temp,
      cliArchiveBase(`${process.platform}-${process.arch}`),
    );
    const installRoot = fs.existsSync(expectedRoot)
      ? expectedRoot
      : path.dirname(findOne(temp, 'product.json'));
    const productManifest = readJson(path.join(installRoot, 'product.json'));
    const entry = (key) =>
      path.join(installRoot, ...productManifest.entries[key].split('/'));
    const kungfuBin = entry('kungfu');
    const compatibilityPath = entry('compatibility');
    const desktopCompatibilityPath = findOne(
      options.desktopDir,
      'product-compatibility.json',
    );
    const compatibility = readJson(compatibilityPath);
    if (compatibility.schema !== fixture.assembled.compatibility_schema)
      fail('CLI compatibility schema mismatch');
    if (sha256File(compatibilityPath) !== sha256File(desktopCompatibilityPath))
      fail('CLI and GUI do not carry the same compatibility manifest');
    for (const component of fixture.assembled.required_components) {
      if (!compatibility.components[component]?.sha256)
        fail(`compatibility manifest missing ${component}`);
    }
    for (const contract of fixture.assembled.preserved_lower_contracts) {
      if (!compatibility.qualification_contracts[contract]?.sha256)
        fail(`compatibility manifest missing lower contract ${contract}`);
    }

    const env = { ...process.env, KF_CONFIG_HOME: path.join(temp, 'config') };
    const started = process.hrtime.bigint();
    const smoke = runInstalledCliSemanticSmoke({ installRoot, kungfuBin, env });
    const coldStartMs = Number(process.hrtime.bigint() - started) / 1e6;
    const before = sha256Tree(smoke.home);
    const guiProjection = path.join(temp, 'installed-gui');
    fs.symlinkSync(options.desktopDir, guiProjection, 'dir');
    fs.rmSync(guiProjection);
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: smoke.home,
      args: [
        'storage',
        'fsck',
        '--scope',
        'episode',
        '--episode-id',
        String(smoke.episodeId),
        '--json',
      ],
      env,
    });
    const after = sha256Tree(smoke.home);
    if (before !== after)
      fail('removing the GUI projection changed the lower-layer data root');

    return {
      status: 'passing',
      source_commit: compatibility.source_commit,
      cli: {
        archive: options.cliArchive,
        sha256: sha256File(options.cliArchive),
        installed_size_bytes: directoryBytes(installRoot),
        semantic_steps: fixture.cli.required_steps,
        cold_start_and_semantic_loop_ms: coldStartMs,
        forbidden_entries: fixture.cli.forbidden_entries,
      },
      gui: {
        desktop_dir: options.desktopDir,
        installed_size_bytes: directoryBytes(options.desktopDir),
        operations: fixture.gui.operations,
        deletion_projection: {
          before_sha256: before,
          after_sha256: after,
          status: 'passing',
        },
      },
      assembled: {
        compatibility_sha256: sha256File(compatibilityPath),
        components: compatibility.components,
        qualification_contracts: compatibility.qualification_contracts,
      },
      boundary:
        'Exact local artifacts and a directory-form GUI deletion projection passed. Installer-specific uninstall behavior, publication, other platforms, and resident-memory budgets remain separate release claims.',
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = sourceValidation();
  const report = options.validateOnly
    ? {
        schema: 'kungfu.surface-qualification.report/v1',
        status: 'source-valid',
        fixture_sha256: sha256File(FIXTURE),
        boundary: 'Source validation does not qualify installed artifacts.',
      }
    : {
        schema: 'kungfu.surface-qualification.report/v1',
        fixture_sha256: sha256File(FIXTURE),
        ...exactQualification(options, fixture),
      };
  if (options.report) {
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(
      options.report,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(
    `[layers:qualify:surfaces] ${report.status}; fixture=${report.fixture_sha256}`,
  );
  console.log(`[layers:qualify:surfaces] ${report.boundary}`);
}

try {
  main();
} catch (error) {
  console.error(
    `[layers:qualify:surfaces] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
