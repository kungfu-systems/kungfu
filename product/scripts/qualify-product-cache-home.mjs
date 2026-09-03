// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_APP = path.join(
  ROOT,
  'product',
  'dist',
  'desktop',
  'mac-arm64',
  'Kungfu.app',
);
const WORK_DESIGN_FIXTURE = path.join(
  ROOT,
  'framework',
  'work-design-preflight',
  'fixtures',
  'installed-preflight-request.json',
);
const AMBIENT_RUNTIME_OVERRIDES = new Set([
  'KF_BUNDLED_EXTENSION_ROOT',
  'KF_CACHE_HOME',
  'KF_CONFIG_HOME',
  'KF_EXTENSION_PATH',
  'KF_HOME',
  'KF_INSTANCE_HOME',
  'KF_RUNTIME_DIR',
  'KF_SKILL_PATH',
  'KUNGFU_AS_VARIANT',
  'KUNGFU_DIR',
  'KUNGFU_INSTALL_SOURCE',
  'KUNGFU_NODE_VARIANT_ENTRY',
  'KUNGFU_UPGRADE_MANIFEST',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONPYCACHEPREFIX',
  'PYTHONDONTWRITEBYTECODE',
]);

function fail(message) {
  throw new Error(`product cache qualification: ${message}`);
}

function bytecodePaths(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  function visit(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') found.push(absolute);
        visit(absolute);
      } else if (entry.name.toLowerCase().endsWith('.pyc')) {
        found.push(absolute);
      }
    }
  }
  visit(root);
  return found;
}

export function treeDigest(root) {
  const digest = crypto.createHash('sha256');
  function visit(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      const header = `${relative}\0${stat.mode}\0`;
      if (entry.isSymbolicLink()) {
        digest.update(`link\0${header}${fs.readlinkSync(absolute)}\0`);
      } else if (entry.isDirectory()) {
        digest.update(`dir\0${header}`);
        visit(absolute);
      } else if (entry.isFile()) {
        digest.update(`file\0${header}${stat.size}\0`);
        digest.update(fs.readFileSync(absolute));
      } else {
        digest.update(`other\0${header}`);
      }
    }
  }
  visit(root);
  return `sha256:${digest.digest('hex')}`;
}

function verifyCodesign(app, runCommand) {
  const result = runCommand(
    'codesign',
    ['--verify', '--deep', '--strict', app],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    fail(`codesign verification failed: ${(result.stderr || '').trim()}`);
  }
}

function runWorkDesignPreflight({
  cli,
  input,
  instanceHome,
  cacheHome,
  env,
  expectedOutcome,
  runCommand,
}) {
  const result = runCommand(
    cli,
    ['--home', instanceHome, 'work-design', 'preflight', '--input', input],
    {
      cwd: cacheHome,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    fail(
      `installed Work Design preflight exited ${result.status ?? result.signal}: ${(result.stderr || '').trim()}`,
    );
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    fail(`installed Work Design preflight returned invalid JSON: ${error}`);
  }
  if (report.outcome !== expectedOutcome) {
    fail(
      `installed Work Design preflight returned ${report.outcome || '<missing>'}, expected ${expectedOutcome}`,
    );
  }
  return report;
}

function qualifyInstalledWorkDesign({
  cli,
  instanceHome,
  cacheHome,
  env,
  runCommand,
}) {
  const request = JSON.parse(fs.readFileSync(WORK_DESIGN_FIXTURE, 'utf8'));
  const automaticInput = path.join(cacheHome, 'work-design-automatic.json');
  const manualInput = path.join(cacheHome, 'work-design-manual.json');
  fs.writeFileSync(automaticInput, `${JSON.stringify(request)}\n`);
  fs.writeFileSync(
    manualInput,
    `${JSON.stringify({
      ...request,
      disposition: {
        action: 'overridden',
        decisionAuthority: 'human',
        rationaleRoot:
          'sha256:df7186e3f525d9207abfb9a533e300f692cb70703886862698296a6d3e1f6b72',
      },
    })}\n`,
  );
  const common = { cli, instanceHome, cacheHome, env, runCommand };
  const automatic = runWorkDesignPreflight({
    ...common,
    input: automaticInput,
    expectedOutcome: 'advisory-auto-adopted',
  });
  const manual = runWorkDesignPreflight({
    ...common,
    input: manualInput,
    expectedOutcome: 'manual-capture',
  });
  if (
    automatic.operation?.mutates !== false ||
    automatic.authority?.assignment !== false ||
    manual.adoption?.adopted !== false ||
    manual.fallback?.silentAdoption !== false
  ) {
    fail('installed Work Design preflight violated its read-only authority');
  }
}

export function qualifyProductCacheHome(options = {}) {
  const app = path.resolve(options.app || DEFAULT_APP);
  const runCommand = options.runCommand || spawnSync;
  const verifySignature =
    options.verifySignature ?? process.platform === 'darwin';
  const cli = path.join(app, 'Contents', 'Resources', 'kungfu', 'kungfu');
  const gui = path.join(app, 'Contents', 'MacOS', 'Kungfu');
  const manifest = path.join(
    app,
    'Contents',
    'Resources',
    'upgrade',
    'kungfu-release-manifest.json',
  );
  if (!fs.statSync(app).isDirectory()) fail(`app is not a directory: ${app}`);
  if (!fs.statSync(cli).isFile()) fail(`bundled CLI is missing: ${cli}`);
  if (!fs.statSync(gui).isFile()) fail(`desktop executable is missing: ${gui}`);
  if (!fs.statSync(manifest).isFile())
    fail(`upgrade manifest is missing: ${manifest}`);

  const initialBytecode = bytecodePaths(app);
  if (initialBytecode.length > 0) {
    fail(`app already contains Python bytecode: ${initialBytecode[0]}`);
  }
  if (verifySignature) verifyCodesign(app, runCommand);
  const beforeDigest = treeDigest(app);

  const cacheHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-product-cache-qualification-'),
  );
  const ambientEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !AMBIENT_RUNTIME_OVERRIDES.has(key.toUpperCase()),
    ),
  );
  const instanceHome = path.join(cacheHome, 'instance');
  const env = {
    ...ambientEnv,
    HOME: path.join(cacheHome, 'home'),
    KF_CACHE_HOME: cacheHome,
    KF_CONFIG_HOME: path.join(cacheHome, 'config'),
    KF_HOME: instanceHome,
    KF_INSTANCE_HOME: instanceHome,
    KF_RUNTIME_DIR: path.join(instanceHome, 'runtime'),
    KUNGFU_UPGRADE_MANIFEST: manifest,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    PYTHONHOME: '',
    PYTHONPATH: '',
  };
  const invocation = runCommand(cli, ['agent', 'brief'], {
    cwd: cacheHome,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (invocation.status !== 0) {
    fail(
      `bundled CLI exited ${invocation.status ?? invocation.signal}: ${(invocation.stderr || '').trim()}`,
    );
  }

  qualifyInstalledWorkDesign({
    cli,
    instanceHome,
    cacheHome,
    env,
    runCommand,
  });

  const guiInvocation = runCommand(gui, [], {
    cwd: cacheHome,
    env: { ...env, KF_QUALIFICATION_MODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (guiInvocation.status !== 0) {
    fail(
      `packaged GUI exited ${guiInvocation.status ?? guiInvocation.signal}: ${(guiInvocation.stderr || '').trim()}`,
    );
  }
  if (!guiInvocation.stdout.includes('KF_GUI_QUALIFICATION_READY')) {
    fail('packaged GUI did not report its qualification-ready marker');
  }

  // Detached Agent Session workers enter the native Node variant before the
  // normal CLI/GUI launchers. Exercise that exact cold path without inherited
  // cache variables, then have it start the bundled interpreter directly. The
  // native executable itself must recover the adjacent release manifest and
  // establish the external, versioned bytecode cache contract.
  const nativeNodeHome = path.join(cacheHome, 'native-node-home');
  const nativeNodeCacheHome = path.join(
    nativeNodeHome,
    'Library',
    'Caches',
    'kungfu',
  );
  fs.mkdirSync(nativeNodeHome, { recursive: true });
  const nativeNodeProbe = path.join(cacheHome, 'native-node-cache-probe.mjs');
  const bundledPython = path.join(
    app,
    'Contents',
    'Resources',
    'kungfu',
    'python',
    'bin',
    'python3',
  );
  fs.writeFileSync(
    nativeNodeProbe,
    [
      "import { spawnSync } from 'node:child_process';",
      'if (!process.env.KF_CACHE_HOME || !process.env.PYTHONPYCACHEPREFIX) process.exit(91);',
      "const child = spawnSync(process.argv[2], ['-c', 'import pkgutil'], { env: process.env, encoding: 'utf8' });",
      "if (child.status !== 0) { process.stderr.write(child.stderr || 'python cache probe failed'); process.exit(child.status ?? 92); }",
      "process.stdout.write('KF_NATIVE_NODE_CACHE_READY\\n');",
    ].join('\n'),
  );
  const nativeNodeEnv = {
    ...ambientEnv,
    HOME: nativeNodeHome,
    KUNGFU_AS_VARIANT: 'node',
    KUNGFU_NODE_VARIANT_ENTRY: nativeNodeProbe,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    PYTHONHOME: '',
    PYTHONPATH: '',
  };
  const nativeNodeInvocation = runCommand(
    cli,
    [nativeNodeProbe, bundledPython],
    {
      cwd: cacheHome,
      env: nativeNodeEnv,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (nativeNodeInvocation.status !== 0) {
    fail(
      `native Node cache probe exited ${nativeNodeInvocation.status ?? nativeNodeInvocation.signal}: ${(nativeNodeInvocation.stderr || '').trim()}`,
    );
  }
  if (!nativeNodeInvocation.stdout.includes('KF_NATIVE_NODE_CACHE_READY')) {
    fail('native Node cache probe did not report its ready marker');
  }

  const afterDigest = treeDigest(app);
  const cacheBytecode = bytecodePaths(path.join(cacheHome, 'python'));
  const nativeNodeBytecode = bytecodePaths(
    path.join(nativeNodeCacheHome, 'python'),
  );
  const finalBytecode = bytecodePaths(app);
  if (beforeDigest !== afterDigest)
    fail('application tree changed after CLI use');
  if (finalBytecode.length > 0) {
    fail(`application gained Python bytecode: ${finalBytecode[0]}`);
  }
  if (cacheBytecode.length === 0) {
    fail('CLI use did not create Python bytecode under KF_CACHE_HOME/python');
  }
  if (nativeNodeBytecode.length === 0) {
    fail('native Node worker did not externalize bundled Python bytecode');
  }
  if (verifySignature) verifyCodesign(app, runCommand);

  return {
    schema: 'kungfu.product-cache-home-qualification/v1',
    qualified: true,
    app,
    appDigest: beforeDigest,
    cacheHome,
    pythonBytecodeFiles: cacheBytecode.length,
    checks: {
      signatureBeforeAndAfter: verifySignature,
      immutableAppTree: true,
      noPackagedPythonBytecode: true,
      externalVersionedPythonCache: true,
      nativeNodeWorkerCacheBootstrap: true,
      packagedGuiBoot: true,
      installedWorkDesignPreflight: true,
      workDesignManualCaptureExplicit: true,
    },
  };
}

function parseArgs(argv) {
  let app = DEFAULT_APP;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app') {
      app = argv[index + 1];
      if (!app) fail('--app requires a path');
      index += 1;
    } else if (argv[index] !== '--json') {
      fail(`unknown argument: ${argv[index]}`);
    }
  }
  return { app };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.stdout.write(
      `${JSON.stringify(qualifyProductCacheHome(parseArgs(process.argv.slice(2))), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
