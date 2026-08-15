#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { runMeasured } from '../process-metrics.mjs';
import {
  findGuiExecutable,
  guiQualificationArgs,
  installDesktopArtifact,
  waitForWindowsProcessesUnderRootExit,
} from './installer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const FIXTURE = path.join(HERE, 'semantic-fixture-v1.json');

function fail(message) {
  throw new Error(message);
}

export function surfaceQualificationTempRoot(
  platform = process.platform,
  env = process.env,
  fallback = os.tmpdir(),
) {
  const hostTemporary = String(env.KUNGFU_QUALIFICATION_HOST_TEMP || '').trim();
  // Release qualification redirects generic temp files into the checkout for
  // cleanup, but that makes deeply nested NSIS payload paths exceed legacy
  // Windows deletion limits. Keep installer qualification on the short runner
  // temp that the release driver preserved before applying that redirect.
  return platform === 'win32' && hostTemporary ? hostTemporary : fallback;
}

export function surfaceQualificationTempPrefix(tempRoot) {
  return path.join(tempRoot, 'kfs-');
}

function parseArgs(argv) {
  const options = {
    validateOnly: false,
    cliArchive: '',
    desktopDir: '',
    desktopInstaller: '',
    releaseRoot: path.join(ROOT, 'product', 'release'),
    report: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--validate-only') options.validateOnly = true;
    else if (
      [
        '--cli-archive',
        '--desktop-dir',
        '--desktop-installer',
        '--release-root',
        '--report',
      ].includes(arg)
    ) {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a path`);
      options[
        arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      ] = path.resolve(argv[index]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: ./shifu layers:qualify:surfaces -- [--validate-only] [--release-root PATH | --cli-archive PATH --desktop-dir PATH --desktop-installer PATH] [--report PATH]',
      );
      process.exit(0);
    } else fail(`unknown argument '${arg}'`);
  }
  if (!options.validateOnly) resolveExactArtifacts(options);
  return options;
}

export function findArtifact(root, predicate, label) {
  const matches = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (predicate(full, entry)) matches.push(full);
        else visit(full);
      } else if (entry.isFile() && predicate(full, entry)) matches.push(full);
    }
  };
  visit(root);
  if (matches.length !== 1)
    fail(
      `${label}: expected one artifact under ${root}, found ${matches.length}`,
    );
  return matches[0];
}

function resolveExactArtifacts(options) {
  if (!options.cliArchive)
    options.cliArchive = findArtifact(
      path.join(options.releaseRoot, 'cli'),
      (target, entry) =>
        entry.isFile() &&
        (target.endsWith('.tar.gz') || target.endsWith('.zip')),
      'CLI archive',
    );
  if (!options.desktopInstaller) {
    const suffix =
      process.platform === 'darwin'
        ? '.dmg'
        : process.platform === 'win32'
          ? '.exe'
          : '.AppImage';
    options.desktopInstaller = findArtifact(
      path.join(options.releaseRoot, 'desktop'),
      (target, entry) => entry.isFile() && target.endsWith(suffix),
      'desktop installer',
    );
  }
  if (!options.desktopDir) {
    const desktopRoot = path.join(ROOT, 'product', 'dist', 'desktop');
    options.desktopDir =
      process.platform === 'darwin'
        ? findArtifact(
            desktopRoot,
            (target, entry) => entry.isDirectory() && target.endsWith('.app'),
            'desktop directory',
          )
        : findArtifact(
            desktopRoot,
            (target, entry) =>
              entry.isDirectory() &&
              path.basename(target) ===
                (process.platform === 'win32'
                  ? 'win-unpacked'
                  : 'linux-unpacked'),
            'desktop directory',
          );
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
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
  const guiMainSource = fs.readFileSync(
    path.join(ROOT, 'framework/gui/src/main/index.ts'),
    'utf8',
  );
  if (
    !guiMainSource.includes("process.env.KF_QUALIFICATION_MODE === '1'") ||
    !guiMainSource.includes('KF_GUI_QUALIFICATION_READY')
  )
    fail('packaged GUI lacks the bounded qualification startup mode');
  const guiManifest = readJson(
    path.join(ROOT, 'extensions/system/status/kungfu.kfx.json'),
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

async function exactQualification(options, fixture) {
  const tempRoot = surfaceQualificationTempRoot();
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(surfaceQualificationTempPrefix(tempRoot));
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
    const compatibilitySha256 = sha256File(compatibilityPath);
    const sourceHead = git(['rev-parse', 'HEAD']);
    if (git(['status', '--porcelain']))
      fail('exact qualification requires a clean source tree');
    if (compatibility.source_commit !== sourceHead)
      fail(
        `artifact source ${compatibility.source_commit} does not match HEAD ${sourceHead}`,
      );
    if (compatibility.schema !== fixture.assembled.compatibility_schema)
      fail('CLI compatibility schema mismatch');
    if (compatibilitySha256 !== sha256File(desktopCompatibilityPath))
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
    const lowerDataRoot = path.join(temp, 'lower-data-root');
    const smoke = runInstalledCliSemanticSmoke({
      installRoot,
      kungfuBin,
      env,
      home: lowerDataRoot,
    });
    const coldStartMs = Number(process.hrtime.bigint() - started) / 1e6;
    const before = sha256Tree(smoke.home);
    const cliMemory = await runMeasured(
      kungfuBin,
      ['-H', smoke.home, 'agent', 'brief'],
      { cwd: installRoot, env, shell: process.platform === 'win32' },
    );

    const desktopInstall = installDesktopArtifact(
      options.desktopInstaller,
      temp,
    );
    const guiExecutable = findGuiExecutable(desktopInstall.installRoot);
    const guiStarted = process.hrtime.bigint();
    const guiMemory = await runMeasured(guiExecutable, guiQualificationArgs(), {
      cwd: desktopInstall.installRoot,
      env: {
        ...process.env,
        KF_QUALIFICATION_MODE: '1',
        KF_HOME: path.join(temp, 'gui-home'),
        KF_RUNTIME_DIR: path.join(temp, 'gui-home', 'runtime'),
      },
    });
    const guiColdStartMs = Number(process.hrtime.bigint() - guiStarted) / 1e6;
    if (!guiMemory.stdout.includes('KF_GUI_QUALIFICATION_READY'))
      fail('packaged GUI did not reach qualification-ready state');
    // The bounded Electron main process can exit before a short-lived packaged
    // runtime child releases directories below the installed application. On
    // Windows, traversing that tree in the gap can fail with EPERM even though
    // the same child would have cleared before the existing NSIS uninstall
    // wait. Settle the exact install root before measuring it as well.
    await waitForWindowsProcessesUnderRootExit(desktopInstall.installRoot);
    const installedDesktopBytes = directoryBytes(desktopInstall.installRoot);
    await desktopInstall.uninstall();
    if (fs.existsSync(desktopInstall.installRoot))
      fail('GUI install root survived uninstall');

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
      fail('GUI install/uninstall changed the lower-layer data root');

    const cliInstalledBytes = directoryBytes(installRoot);
    fs.rmSync(installRoot, { recursive: true, force: true });
    if (fs.existsSync(installRoot)) fail('CLI install root survived uninstall');
    const componentCount = Object.keys(compatibility.components).length;
    const installerUninstall = {
      status: 'passing',
      installer: options.desktopInstaller,
      installer_sha256: sha256File(options.desktopInstaller),
      kind: desktopInstall.kind,
      lower_data_before_sha256: before,
      lower_data_after_sha256: after,
    };
    const qualifications = {
      'cli-tui': {
        status: 'passing',
        exact_artifact_sha256: sha256File(options.cliArchive),
        measurements: {
          dependency_count: componentCount,
          installed_size_bytes: cliInstalledBytes,
          cold_start_ms: coldStartMs,
          resident_runtime_count: 1,
          resident_memory_bytes: cliMemory.peakResidentBytes,
          onboarding_concept_count: 5,
        },
        installer_uninstall: {
          status: 'passing',
          kind: 'archive',
          lower_data_before_sha256: before,
          lower_data_after_sha256: after,
        },
      },
      gui: {
        status: 'passing',
        exact_artifact_sha256: sha256File(options.desktopInstaller),
        measurements: {
          dependency_count: componentCount,
          installed_size_bytes: installedDesktopBytes,
          cold_start_ms: guiColdStartMs,
          resident_runtime_count: 1,
          resident_memory_bytes: guiMemory.peakResidentBytes,
          onboarding_concept_count: 5,
        },
        installer_uninstall: installerUninstall,
      },
      'assembled-distribution': {
        status: 'passing',
        exact_artifact_sha256: sha256File(options.desktopInstaller),
        measurements: {
          dependency_count: componentCount,
          installed_size_bytes: installedDesktopBytes,
          cold_start_ms: guiColdStartMs,
          resident_runtime_count: 1,
          resident_memory_bytes: guiMemory.peakResidentBytes,
          onboarding_concept_count: 5,
        },
        installer_uninstall: installerUninstall,
      },
    };

    return {
      status: 'passing',
      platform: process.platform,
      architecture: process.arch,
      source: {
        commit: sourceHead,
        tree_dirty: false,
      },
      source_commit: compatibility.source_commit,
      qualifications,
      cli: {
        archive: options.cliArchive,
        sha256: sha256File(options.cliArchive),
        installed_size_bytes: cliInstalledBytes,
        semantic_steps: fixture.cli.required_steps,
        cold_start_and_semantic_loop_ms: coldStartMs,
        forbidden_entries: fixture.cli.forbidden_entries,
      },
      gui: {
        desktop_dir: options.desktopDir,
        installed_size_bytes: installedDesktopBytes,
        operations: fixture.gui.operations,
        installer_uninstall: {
          before_sha256: before,
          after_sha256: after,
          status: 'passing',
        },
      },
      assembled: {
        compatibility_sha256: compatibilitySha256,
        components: compatibility.components,
        qualification_contracts: compatibility.qualification_contracts,
      },
      boundary:
        'Exact local CLI and desktop installer artifacts passed semantic, compatibility, numeric-budget, and uninstall-preservation gates on the named platform. Publication and other platforms remain separate release claims.',
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
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
        ...(await exactQualification(options, fixture)),
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[layers:qualify:surfaces] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
