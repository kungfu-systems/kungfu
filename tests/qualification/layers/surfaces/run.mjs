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
} from '@kungfu-tech/product-kungfu/tooling/archive';
import {
  sha256File,
  sha256Tree,
} from '@kungfu-tech/product-kungfu/tooling/compatibility';
import {
  cliArchiveBase,
  runInstalledCliSemanticSmoke,
  runInstalledKungfu,
  runInstalledKungfuAssignmentAdmissionSmoke,
} from '@kungfu-tech/product-kungfu/tooling/dist';
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

export function seedGlobalWorkQualification(
  configHome,
  observedQuery,
  componentCount = 2048,
) {
  const statePath = path.join(configHome, 'gui', 'global-work-observer.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    path.join(configHome, 'config.json'),
    `${JSON.stringify({
      ui: {
        onboarding: {
          version: 1,
          status: 'completed',
          route: 'agent',
          labCompleted: false,
          tourCompleted: false,
          completedAt: '2026-01-01T00:00:00Z',
        },
      },
    })}\n`,
  );
  const observedAt = observedQuery.observed_at || '2026-01-01T00:00:00Z';
  const query = {
    ...observedQuery,
    observed_at: observedAt,
    components: [
      ...(Array.isArray(observedQuery.components)
        ? observedQuery.components
        : []),
      ...Array.from({ length: componentCount }, (_, index) => ({
        workspace_id: `large-snapshot-${index}`,
        qualification_padding: 'x'.repeat(2048),
      })),
    ],
  };
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      schema: 'kungfu.gui.global-work-observer/v2',
      catalog_cut: query.proof?.catalog_cut || '',
      cursors: {},
      signals: {},
      query,
    })}\n`,
  );
  return statePath;
}

const AMBIENT_PRODUCT_PREFIXES = [
  'ELECTRON_',
  'KFE_',
  'KF_',
  'KUNGFU_',
  'NODE_',
  'PYTHON',
];

export function isolatedSurfaceProductEnvironment(env = process.env) {
  const isolated = Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const normalized = key.toUpperCase();
      return !AMBIENT_PRODUCT_PREFIXES.some((prefix) =>
        normalized.startsWith(prefix),
      );
    }),
  );
  return {
    ...isolated,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    PYTHONHOME: '',
    PYTHONPATH: '',
  };
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

    const productEnv = isolatedSurfaceProductEnvironment(process.env);
    const env = { ...productEnv, KF_CONFIG_HOME: path.join(temp, 'config') };
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
    const guiConfigHome = path.join(temp, 'gui-config');
    const guiUserHome = path.join(temp, 'gui-user');
    const guiDataHome = path.join(guiUserHome, '.kungfu');
    const admission = runInstalledKungfuAssignmentAdmissionSmoke({
      installRoot,
      kungfuBin,
      env: { ...env, KF_CONFIG_HOME: guiConfigHome },
      home: guiDataHome,
      userHome: guiUserHome,
      workspace: path.join(temp, 'assignment-admission-workspace'),
      requestPath: path.join(temp, 'assignment-admission-request.json'),
    });
    const observedQuery = JSON.parse(
      runInstalledKungfu({
        kungfuBin,
        installRoot,
        home: guiDataHome,
        args: [
          'workspace',
          'work',
          '--scope',
          'all',
          '--include-settled',
          '--json',
        ],
        env: { ...env, KF_CONFIG_HOME: guiConfigHome },
      }),
    );
    const admittedWorkspace = admission.admitted.workspace;
    const admittedRow = observedQuery.global_work?.visible_work?.find(
      (row) =>
        row.object_kind === 'assignment' &&
        row.display?.title === 'Verify installed Assignment admission' &&
        row.observations?.some(
          (observation) =>
            observation.workspace_id === admittedWorkspace.workspace_id &&
            observation.workspace_identity_root ===
              admittedWorkspace.identity_root,
        ),
    );
    if (!admittedRow)
      fail(
        'installed global Work query did not contain the exact admitted Work',
      );
    const observerState = seedGlobalWorkQualification(
      guiConfigHome,
      observedQuery,
    );
    const authorityRoot = path.join(admission.workspace, '.kungfu');
    const authorityBefore = sha256Tree(authorityRoot);
    const observerStateBytes = fs.statSync(observerState).size;
    if (observerStateBytes < 4 * 1024 * 1024)
      fail('large global Work qualification snapshot is too small');
    const guiStarted = process.hrtime.bigint();
    const guiMemory = await runMeasured(guiExecutable, guiQualificationArgs(), {
      cwd: desktopInstall.installRoot,
      env: {
        ...productEnv,
        HOME: guiUserHome,
        USERPROFILE: guiUserHome,
        KF_QUALIFICATION_MODE: '1',
        KF_QUALIFICATION_ALL_WORK: '1',
        KF_QUALIFICATION_EXPECTED_WORK_TITLE:
          'Verify installed Assignment admission',
        KF_CONFIG_HOME: guiConfigHome,
        KF_HOME: guiDataHome,
        KF_RUNTIME_DIR: path.join(guiDataHome, 'runtime'),
      },
    });
    const guiColdStartMs = Number(process.hrtime.bigint() - guiStarted) / 1e6;
    if (!guiMemory.stdout.includes('KF_GUI_QUALIFICATION_READY'))
      fail('packaged GUI did not reach qualification-ready state');
    if (!guiMemory.stdout.includes('KF_GUI_QUALIFICATION_ALL_WORK_READY'))
      fail(
        `packaged GUI did not render the seeded All Work snapshot; stdout=${guiMemory.stdout.slice(-4096)} stderr=${guiMemory.stderr.slice(-4096)}`,
      );
    const authorityAfter = sha256Tree(authorityRoot);
    if (authorityBefore !== authorityAfter)
      fail('packaged GUI changed the Work authority fixture');
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
