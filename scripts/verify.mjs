// SPDX-License-Identifier: Apache-2.0
//
// verify — end-to-end "green" verification of the kungfu build chain (modernization assessment spec B3)
//
// Converges the Phase 1 gate — previously run by hand across scattered steps (freeze → build:core →
// build:app → launch app) with no single criterion — into a reproducible "one command + assert
// artifacts" criterion, which also serves as a CI smoke baseline.
//
// Usage (node pinned via the entrypoint; plain `node scripts/verify.mjs` works):
//   ./shifu verify              quick: only assert "existing" artifacts (dist/kungfu exists + kungfu runs + version matches)
//   ./shifu verify --full       full: rebuild:core + freeze first, then assert; also builds and runs the
//                                     capability slices (framework/core/slices) + yijinjing dependency guard
//   ./shifu verify --with-app   also assert the build:app artifact (with --full it builds the app first)
//   ./shifu verify --fuzz       add the kungfu::view libFuzzer long-run (KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc memory safety); needs a
//                                     libFuzzer-capable clang (brew LLVM on macOS, system clang on Linux). The
//                                     alpha/release build passes this; a new crash blocks the build.
//   ./shifu verify --skip-episode-qualification
//                                     diagnostic-only escape hatch; the default verify path runs the
//                                     mvp-smoke-v1 Episode qualification profile.
//   ./shifu verify --help
//
// Assertion targets (all grounded in the build scripts, not guessed):
//   - framework/core/dist/kungfu/                     assembled product core dist (run-freeze.js target)
//   - framework/core/dist/kungfu/kungfu[.exe]           kungfu executable (path resolved by lib/executable.js)
//   - `kungfu --version` exits 0 and output contains the expected version   product Python runtime runs end to end (runtime smoke)
//   - framework/gui/out/                           (--with-app) build:app electron-vite artifact
//
// Exit codes: all green 0; any failed assertion 1 (fail-fast prints copy-pastable troubleshooting info).
// Note: an Electron app's "interactive launch" cannot be asserted in a headless environment, so kungfu
// runtime smoke + app build artifact existence serve as the machine-assertable equivalent; the real
// window launch is left as a manual / CI-display step.
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLibwasmArtifact,
  runLibwasmArtifactSelfTest,
  runLibwasmExecutionQualification,
} from '../product/scripts/libwasm-artifact.mjs';
import { sourceMypyCommand } from './source-acceptance.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..'); // repo root (this file lives in scripts/)
const isWin = process.platform === 'win32';
const require = createRequire(import.meta.url);
const { contractArtifacts } = require('./contract-registry.cjs');

// Prefer a cross-platform run.mjs (node) over the legacy run.sh (bash) so
// fixtures/slices migrate off the bash dependency incrementally; returns null
// when a dir carries neither runner.
function runnerFor(dir) {
  const mjs = path.join(dir, 'run.mjs');
  if (fs.existsSync(mjs))
    return { cmd: process.execPath, args: [mjs], label: 'run.mjs' };
  const sh = path.join(dir, 'run.sh');
  if (fs.existsSync(sh)) return { cmd: 'bash', args: [sh], label: 'run.sh' };
  return null;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  // print the file header usage block (up to the first blank comment line)
  const head = fs.readFileSync(__filename, 'utf8').split('\n');
  for (const line of head) {
    if (!line.startsWith('//')) break;
    console.log(line.replace(/^\/\/ ?/, ''));
  }
  process.exit(0);
}
const doFull = args.includes('--full');
const withApp = args.includes('--with-app');
const skipEpisodeQualification = args.includes('--skip-episode-qualification');
// --fuzz adds the libFuzzer long-run tier (needs a libFuzzer-capable clang); the
// alpha/release build passes it. The lightweight ASan/UBSan corpus replay runs
// whenever the memory-safety stage runs (full or fuzz).
const doFuzz = args.includes('--fuzz');

// expected version: single source of truth is lerna.json (maintained by the release workflow)
function expectedVersion() {
  const lerna = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'lerna.json'), 'utf8'),
  );
  return lerna.version;
}

/** @typedef {{ name: string, ok: boolean, detail: string }} Result */
/** @type {Result[]} */
const results = [];
/**
 * @param {string} name
 * @param {string} [detail]
 */
function pass(name, detail) {
  results.push({ name, ok: true, detail: detail || '' });
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
/**
 * @param {string} name
 * @param {string} [detail]
 */
function fail(name, detail) {
  results.push({ name, ok: false, detail: detail || '' });
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function exitLabel(status, signal) {
  return status == null ? `signal ${signal}` : status;
}

function outputTail(stdout, stderr, lines = 3) {
  return `${stdout || ''}${stderr || ''}`
    .trim()
    .split('\n')
    .slice(-lines)
    .join(' | ');
}

function assertContractArtifact(distDir, artifact) {
  const repoContract = path.join(ROOT, artifact.source);
  const distContract = path.join(distDir, artifact.artifact);
  if (fs.existsSync(distContract)) {
    const repoHash = sha256(repoContract);
    const distHash = sha256(distContract);
    if (repoHash === distHash) {
      pass(
        `${artifact.label} artifact hash`,
        `${path.relative(ROOT, distContract)} sha256:${distHash}`,
      );
    } else {
      fail(
        `${artifact.label} artifact hash`,
        `dist sha256:${distHash} != repo sha256:${repoHash}`,
      );
    }
  } else {
    fail(
      `${artifact.label} artifact exists`,
      `not found ${path.relative(ROOT, distContract)} (build:core/freeze should copy it)`,
    );
  }
}

// run one pnpm task (via the pnpm dispatched by the current node/corepack); throw on failure
/** @param {string} task */
function runPnpm(task) {
  console.log(`\n[verify] build stage: pnpm ${task}`);
  const r = spawnSync('pnpm', ['run', task], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
  });
  if (r.status !== 0) {
    throw new Error(
      `pnpm ${task} failed (exit ${exitLabel(r.status, r.signal)})`,
    );
  }
}

function runEpisodeQualificationSmoke() {
  console.log('\n[verify] stage 3b: Episode qualification (mvp-smoke-v1)');
  if (skipEpisodeQualification) {
    console.log(
      '  (skipped: explicitly requested with --skip-episode-qualification; Buildchain and alpha/release do not use this bypass)',
    );
    return;
  }

  const harness = path.join(
    ROOT,
    'framework',
    'core',
    'tests',
    'qualification',
    'episode',
    'run.mjs',
  );
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-verify-episode-'));
  const reportPath = path.join(runRoot, 'episode-trust-report.json');
  const smoke = spawnSync(
    process.execPath,
    [harness, '--profile', 'mvp-smoke-v1', '--report', reportPath],
    {
      cwd: ROOT,
      encoding: 'utf8',
      // The smoke is intentionally load-bearing and exercises 1k-episode
      // accumulation plus contended writers.  Slower Linux qualification
      // runners can legitimately exceed fifteen minutes without hanging.
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const tail = outputTail(smoke.stdout, smoke.stderr, 8);
  if (smoke.error || smoke.status !== 0) {
    const processDetail = smoke.error
      ? `${smoke.error.code || smoke.error.message}`
      : `exit ${exitLabel(smoke.status, smoke.signal)}`;
    fail(
      'Episode qualification smoke',
      `${processDetail}; report/runtime retained under ${runRoot}${tail ? `; tail: ${tail}` : ''}`,
    );
    return;
  }

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const scenarios = report?.workload?.scenarios || [];
    const scenariosPassed = scenarios.filter((scenario) => scenario.ok).length;
    const requiredSemanticDimensions =
      report?.semantic_evidence?.required_dimensions || [];
    const semanticDimensions = report?.semantic_evidence?.dimensions || {};
    const semanticPassed = requiredSemanticDimensions.filter(
      (dimension) => semanticDimensions[dimension]?.status === 'passed',
    ).length;
    if (
      report?.schema !== 'kungfu.episode.trust-report/v2' ||
      report?.profile !== 'mvp-smoke-v1' ||
      scenarios.length === 0 ||
      scenariosPassed !== scenarios.length ||
      requiredSemanticDimensions.length === 0 ||
      semanticPassed !== requiredSemanticDimensions.length
    ) {
      fail(
        'Episode qualification smoke',
        `unexpected Trust Report contract; report retained at ${reportPath}`,
      );
      return;
    }
    if (process.env.CI && report.qualified !== true) {
      const trackedStatus = spawnSync(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      const trackedDetail = (trackedStatus.stdout || '')
        .trim()
        .split(/\r?\n/)
        .slice(0, 20)
        .join(' | ');
      fail(
        'Episode qualification smoke',
        `CI requires a clean-source qualified Trust Report; tracked status: ${trackedDetail || 'clean'}; report retained at ${reportPath}`,
      );
      return;
    }
    const busy = report.performance?.scenarios
      ?.flatMap((scenario) => scenario.writers || [])
      .reduce(
        (total, writer) =>
          total + (writer.operations?.manifest_writer_busy || 0),
        0,
      );
    pass(
      'Episode qualification smoke',
      `${scenariosPassed}/${scenarios.length} scale scenarios; ${semanticPassed}/${requiredSemanticDimensions.length} required semantic dimensions; busy=${busy || 0}; qualified=${String(report.qualified)}`,
    );
    fs.rmSync(runRoot, { recursive: true, force: true });
  } catch (error) {
    fail(
      'Episode qualification smoke',
      `invalid or missing Trust Report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyShifuEntryContract() {
  // ── Stage 0: development/build entrypoint contract (read-only) ───
  // Buildchain lifecycle verification enters here through ./shifu verify, so
  // this keeps CI command surfaces and agent guidance from silently regressing
  // to direct package-manager/toolchain invocation.
  console.log('\n[verify] stage 0: Shifu entry contract');
  const shifuEntry = spawnSync(
    process.execPath,
    [path.join(__dirname, 'check-shifu-entry-contract.mjs')],
    { encoding: 'utf8' },
  );
  if (shifuEntry.status === 0)
    pass('Shifu entry contract', 'participant commands enter through Shifu');
  else
    fail(
      'Shifu entry contract',
      outputTail(shifuEntry.stdout, shifuEntry.stderr, 8) ||
        `exit ${exitLabel(shifuEntry.status, shifuEntry.signal)}`,
    );
}

function verifyNoBashGuard() {
  // ── Stage 0a: cross-platform script guard (read-only) ─────────────
  // Tooling drives its fixtures/slices/guards/benches through Node so it runs on
  // every platform pnpm runs on (Windows included). A bash `.sh` anywhere in the
  // tree silently breaks off-Unix — the repo is fully migrated (zero .sh), so
  // fail loudly on any reintroduction. The scan is shared with the pre-commit
  // hook via no-bash-guard.mjs (single source of truth); run it whole-tree here.
  console.log('\n[verify] stage 0a: no-bash script guard');
  const noBash = spawnSync(
    process.execPath,
    [path.join(__dirname, 'no-bash-guard.mjs')],
    { encoding: 'utf8' },
  );
  if (noBash.status === 0)
    pass('no-bash script guard', 'gates are Node-only (cross-platform)');
  else
    fail(
      'no-bash script guard',
      `${noBash.stdout || ''}${noBash.stderr || ''}`.trim() ||
        'bash scripts must be Node (.mjs) so the gate runs on Windows too',
    );
}

function verifyGateCatalog() {
  // ── Stage 0aa: Kungfu Gate catalog (read-only) ───────────────────
  console.log('\\n[verify] stage 0aa: Kungfu Gate catalog');
  const gateCatalog = spawnSync(
    process.execPath,
    [path.join(__dirname, 'check-kungfu-gate-catalog.mjs')],
    { encoding: 'utf8' },
  );
  if (gateCatalog.status === 0)
    pass('Kungfu Gate catalog', 'registry, docs, matrix and workflows align');
  else
    fail(
      'Kungfu Gate catalog',
      outputTail(gateCatalog.stdout, gateCatalog.stderr, 8) ||
        `exit ${exitLabel(gateCatalog.status, gateCatalog.signal)}`,
    );
}

function verifyPythonTypes() {
  // ── Stage 0b: python type check (read-only) ───────────────────────
  // Gradual mypy baseline: annotated modules are type-checked, the un-annotated
  // bulk is skipped, and a small snapshot of pre-existing errors is ignored (see
  // [tool.mypy] in framework/core/pyproject.toml). Keeps Python honest as
  // annotations land, with no big-bang. Read-only; runs in quick and full.
  console.log('\n[verify] stage 0b: python type check (mypy)');
  const coreDir = path.join(ROOT, 'framework', 'core');
  const mypyInvocation = sourceMypyCommand([]);
  const mypy = spawnSync(mypyInvocation.command, mypyInvocation.args, {
    cwd: coreDir,
    encoding: 'utf8',
    shell: isWin,
  });
  if (mypy.status === 0) pass('python type check', 'mypy baseline clean');
  else if (
    isWin &&
    `${mypy.stdout || ''}${mypy.stderr || ''}`.includes('os error 448')
  ) {
    console.log(
      `  (skipped on Windows: uv interpreter discovery hit runner mount-point error 448; tail: ${outputTail(mypy.stdout, mypy.stderr)})`,
    );
  } else
    fail(
      'python type check',
      outputTail(mypy.stdout, mypy.stderr) || `mypy exited ${mypy.status}`,
    );
}

function verifyAgentPack() {
  // ── Stage 0c: installed agent onboarding pack ────────────────────
  // The pack is a shipped local fact source. It must be present before any
  // artifact can honestly claim agent-ready install paths.
  console.log('\n[verify] stage 0c: agent onboarding pack');
  const agentPack = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-agent-pack.mjs')],
    { encoding: 'utf8' },
  );
  if (agentPack.status === 0)
    pass('agent onboarding pack', (agentPack.stdout || '').trim());
  else
    fail(
      'agent onboarding pack',
      `${agentPack.stdout || ''}${agentPack.stderr || ''}`.trim() ||
        `verify-agent-pack exited ${agentPack.status}`,
    );
}

function verifyKfd2Claims() {
  // ── Stage 0d: KFD-2 release claims registry ──────────────────────
  // Product intent remains Kungfu-owned; Buildchain validates the canonical
  // registry and generated release projections without writing files.
  console.log('\n[verify] stage 0d: KFD-2 release claims registry');
  const kfd3PrebuildWitness = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        '.buildchain',
        'kfd',
        'kfd-3',
        'collaboration-interface.prebuild.json',
      ),
      'utf8',
    ),
  );
  const kfd2SourceSha = kfd3PrebuildWitness?.source?.sourceSha;
  if (typeof kfd2SourceSha !== 'string' || kfd2SourceSha.length === 0) {
    throw new Error(
      'KFD-2 release claims check requires source.sourceSha from the canonical KFD-3 prebuild witness',
    );
  }
  const kfd2Claims = spawnSync(
    'pnpm',
    [
      'exec',
      'buildchain',
      'kfd',
      '2',
      'product-claims',
      'check',
      '--source-sha',
      kfd2SourceSha,
    ],
    { encoding: 'utf8', shell: isWin },
  );
  if (kfd2Claims.status === 0)
    pass('KFD-2 release claims registry', (kfd2Claims.stdout || '').trim());
  else
    fail(
      'KFD-2 release claims registry',
      `${kfd2Claims.stdout || ''}${kfd2Claims.stderr || ''}`.trim() ||
        `Buildchain product-claims exited ${kfd2Claims.status}`,
    );
}

function verifyBuildchainKfdEvidence() {
  // ── Stage 0e: Buildchain KFD release evidence ───────────────────
  // The release workflow consumes KFD-1/2/3 evidence through Buildchain v3.
  // Keep the tracked KFD-3 registry and generated witness inputs aligned with
  // Kungfu's local contract, trust-claim, and collaboration-interface facts.
  console.log('\n[verify] stage 0e: Buildchain KFD release evidence');
  const buildchainKfd = spawnSync(
    process.execPath,
    [path.join(__dirname, 'buildchain-kfd-evidence.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  if (buildchainKfd.status === 0)
    pass(
      'Buildchain KFD release evidence',
      (buildchainKfd.stdout || '').trim(),
    );
  else
    fail(
      'Buildchain KFD release evidence',
      `${buildchainKfd.stdout || ''}${buildchainKfd.stderr || ''}`.trim() ||
        `buildchain-kfd-evidence exited ${buildchainKfd.status}`,
    );
}

function verifyToolchain() {
  // ── Stage 0: toolchain preflight (read-only) ──────────────────────
  console.log('\n[verify] stage 0: toolchain preflight');
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', shell: isWin });
  if (uv.status === 0) pass('uv available', (uv.stdout || '').trim());
  else
    fail(
      'uv available',
      'uv not found (the Python build chain depends on uv); a full build will fail',
    );

  const nodeVersionFile = path.join(ROOT, '.node-version');
  if (fs.existsSync(nodeVersionFile)) {
    const want = fs.readFileSync(nodeVersionFile, 'utf8').trim();
    const got = process.versions.node;
    if (got === want) pass('node version pinned', `v${got}`);
    else
      fail(
        'node version pinned',
        `current v${got} ≠ .node-version ${want} (run via ./shifu)`,
      );
  }
}

function runBuildStage() {
  // ── Stage 1: (optional) build ─────────────────────────────────────
  if (doFull) {
    try {
      runPnpm('rebuild:core'); // clean + build:conan C++/wheel/native
      // Freeze before the dogfood probes: the extension build they run is
      // `kungfu sdk kfx build`, which launches the product kungfu runtime — so
      // dist/kungfu must exist first. (Before the kfs→`kungfu sdk` move the
      // probe used a plain-node bin and could run pre-freeze; it can't now.)
      runPnpm('freeze'); // assemble leg (every platform, KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2) → framework/core/dist/kungfu
      // C++ dogfood probe: compile the reference cpp kfx against the freshly
      // built libkungfu (headers + shared lib + FlatBuffers) into a native
      // module. If a core capability regresses, this build breaks here.
      const probeBuild = spawnSync(
        'pnpm',
        ['--filter', '@kungfu-tech/examples-probe-cpp', 'run', 'build'],
        {
          cwd: ROOT,
          stdio: 'inherit',
          shell: isWin,
        },
      );
      if (probeBuild.status !== 0) {
        throw new Error(
          `cpp probe build failed (exit ${exitLabel(probeBuild.status, probeBuild.signal)})`,
        );
      }
      // Python AOT dogfood probe: install its dependency (engage pdm) and
      // Nuitka-compile it (engage nuitka) — exercises the bundled python
      // toolchain against the freshly built core.
      const pyProbeBuild = spawnSync(
        'pnpm',
        ['--filter', '@kungfu-tech/examples-probe-python', 'run', 'build'],
        {
          cwd: ROOT,
          stdio: 'inherit',
          shell: isWin,
        },
      );
      if (pyProbeBuild.status !== 0) {
        throw new Error(
          `python probe build failed (exit ${exitLabel(pyProbeBuild.status, pyProbeBuild.signal)})`,
        );
      }
      // KFX distribution fixtures pack/install the real work-dashboard
      // extension. Build it here so `verify --full` is a complete gate instead
      // of depending on a manual pre-run `kungfu sdk kfx build`.
      const workDashboardBuild = spawnSync(
        'pnpm',
        ['--filter', '@kungfu-tech/kfx-view-work-dashboard', 'run', 'build'],
        {
          cwd: ROOT,
          stdio: 'inherit',
          shell: isWin,
        },
      );
      if (workDashboardBuild.status !== 0) {
        throw new Error(
          `work-dashboard kfx build failed (exit ${exitLabel(workDashboardBuild.status, workDashboardBuild.signal)})`,
        );
      }
      if (withApp) runPnpm('build:app'); // electron-vite → framework/gui/out
    } catch (e) {
      fail('build stage', e instanceof Error ? e.message : String(e));
      return false; // on build failure, wrap up directly and do not assert half-built artifacts
    }
    pass('build stage', 'full chain executed');
  }
  return true;
}

function verifyKungfuArtifacts() {
  // ── Stage 2: kungfu artifact assertions ──────────────────────────────
  console.log('\n[verify] stage 2: kungfu artifact assertions');
  const distDir = path.join(ROOT, 'framework', 'core', 'dist', 'kungfu');
  let kungfuBin = null;
  if (fs.existsSync(distDir) && fs.statSync(distDir).isDirectory()) {
    pass('dist/kungfu directory exists', path.relative(ROOT, distDir));
    for (const artifact of contractArtifacts()) {
      assertContractArtifact(distDir, artifact);
    }
    try {
      const files = assertLibwasmArtifact(distDir);
      pass('production libwasm artifact', `${files.length} required files`);
      const receipt = runLibwasmArtifactSelfTest(distDir);
      pass(
        'production libwasm metering',
        `wasmtime=${receipt.engines.wasmtime.status} wasmer=${receipt.engines.wasmer.status}`,
      );
      const executions = runLibwasmExecutionQualification(distDir);
      pass(
        'production libwasm execution receipts',
        `wasmtime=${executions.wasmtime.frame_count} wasmer=${executions.wasmer.frame_count}`,
      );
    } catch (error) {
      fail(
        'production libwasm artifact',
        error instanceof Error ? error.message : String(error),
      );
    }
    kungfuBin = path.join(distDir, isWin ? 'kungfu.exe' : 'kungfu');
    if (fs.existsSync(kungfuBin) && fs.statSync(kungfuBin).isFile()) {
      const detail = path.relative(ROOT, kungfuBin);
      if (!isWin) {
        const mode = fs.statSync(kungfuBin).mode;
        if (!(mode & 0o111)) {
          fail('kungfu executable', `${detail} missing executable bit`);
          kungfuBin = null;
        } else pass('kungfu executable exists', detail);
      } else pass('kungfu executable exists', detail);
    } else {
      fail(
        'kungfu executable exists',
        `not found ${path.relative(ROOT, kungfuBin)} (freeze first)`,
      );
      kungfuBin = null;
    }
    // Assembled form (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2): when the dist carries the
    // interpreter tree, it must be well-formed — the host marker declares
    // the form and the tree's python3 is the real sys.executable the entry
    // execs. The interpreter tree is mandatory for every supported product.
    const assembledTree = path.join(distDir, 'python');
    if (fs.existsSync(assembledTree)) {
      // The tree's interpreter is at python.exe on Windows, bin/python3 on
      // POSIX (same fork as run-freeze.js assembleLayout and the trunk's
      // tree_python) — it is the real sys.executable the entry execs.
      const treePython =
        process.platform === 'win32'
          ? path.join(assembledTree, 'python.exe')
          : path.join(assembledTree, 'bin', 'python3');
      const required = [
        path.join(assembledTree, 'kungfu-host.json'),
        treePython,
      ];
      const missing = required.filter((p) => !fs.existsSync(p));
      if (!missing.length) {
        pass(
          'assembled runtime tree well-formed',
          path.relative(ROOT, assembledTree),
        );
      } else {
        fail(
          'assembled runtime tree well-formed',
          `missing ${missing.map((p) => path.relative(ROOT, p)).join(', ')}`,
        );
      }
    } else {
      fail(
        'assembled runtime tree well-formed',
        `missing ${path.relative(ROOT, assembledTree)}`,
      );
    }
  } else {
    fail(
      'dist/kungfu directory exists',
      `not found ${path.relative(ROOT, distDir)} (freeze first; in quick mode, confirm it was built)`,
    );
  }
  return kungfuBin;
}

function verifyCppProbe() {
  // ── Stage 2b: C++ extension probe artifact ────────────────────────
  // The reference cpp example (examples/probe-cpp) compiles against libkungfu and
  // its FlatBuffers types into a native module; its presence proves the C++
  // extension build path. Built in Stage 1 under --full.
  console.log('\n[verify] stage 2b: C++ extension probe artifact');
  const probeDist = path.join(
    ROOT,
    'examples',
    'probe-cpp',
    'dist',
    'ProbeCpp',
  );
  const probeSo = fs.existsSync(probeDist)
    ? fs
        .readdirSync(probeDist)
        .find((f) => /^probe_cpp\..*\.(so|dylib|pyd)$/.test(f))
    : null;
  if (probeSo) {
    pass(
      'cpp probe native module built',
      path.relative(ROOT, path.join(probeDist, probeSo)),
    );
  } else if (doFull) {
    fail(
      'cpp probe native module built',
      `no probe_cpp.*.(so|dylib|pyd) under ${path.relative(ROOT, probeDist)}`,
    );
  } else {
    console.log(
      `  (skipped: no cpp probe artifact; build it with 'pnpm --filter @kungfu-tech/examples-probe-cpp run build' or --full)`,
    );
  }
}

function verifyPythonProbe() {
  // ── Stage 2c: Python AOT extension probe artifact ─────────────────
  // The reference python example (examples/probe-python) is Nuitka-compiled into a
  // native module through the bundled toolchain; its presence proves the
  // python-AOT extension build path. Built in Stage 1 under --full.
  console.log('\n[verify] stage 2c: Python AOT extension probe artifact');
  const pyProbeDist = path.join(
    ROOT,
    'examples',
    'probe-python',
    'dist',
    'ProbePython',
  );
  const pyProbeSo = fs.existsSync(pyProbeDist)
    ? fs
        .readdirSync(pyProbeDist)
        .find((f) => /^ProbePython\..*\.(so|dylib|pyd)$/.test(f))
    : null;
  if (pyProbeSo) {
    pass(
      'python probe native module built',
      path.relative(ROOT, path.join(pyProbeDist, pyProbeSo)),
    );
  } else if (doFull) {
    fail(
      'python probe native module built',
      `no ProbePython.*.(so|dylib|pyd) under ${path.relative(ROOT, pyProbeDist)}`,
    );
  } else {
    console.log(
      `  (skipped: no python probe artifact; build it with 'pnpm --filter @kungfu-tech/examples-probe-python run build' or --full)`,
    );
  }
}

function runKungfuJson(kungfuBin, command, name) {
  const result = spawnSync(kungfuBin, command, { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(
      name,
      `exit ${exitLabel(result.status, result.signal)}; output: ${`${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 200)}`,
    );
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(
      name,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function verifyRuntimeVersion(kungfuBin, version) {
  const result = spawnSync(kungfuBin, ['--version'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    fail(
      'kungfu --version exits 0',
      `exit ${exitLabel(result.status, result.signal)}; output: ${output.slice(0, 200)}`,
    );
  } else if (!output.includes(version)) {
    fail(
      'kungfu version matches',
      `expected to contain ${version}, got: ${output.slice(0, 200)}`,
    );
  } else {
    pass('kungfu runtime smoke', `--version contains ${version}`);
  }
}

function verifyConfigContract(kungfuBin) {
  const resolved = runKungfuJson(
    kungfuBin,
    ['config', 'show', '--json'],
    'kungfu config contract smoke',
  );
  if (resolved === undefined) return;
  const repoContract = path.join(
    ROOT,
    'framework',
    'config',
    'kungfu-config.contract.json',
  );
  const expectedHash = `sha256:${sha256(repoContract)}`;
  if (resolved?.contract?.hash === expectedHash) {
    pass('kungfu config contract smoke', expectedHash);
  } else {
    fail(
      'kungfu config contract smoke',
      `resolved hash ${resolved?.contract?.hash || '<missing>'} != ${expectedHash}`,
    );
  }
}

function verifyKfxContract(kungfuBin) {
  const contract = runKungfuJson(
    kungfuBin,
    ['kfx', 'contract', '--json'],
    'kungfu kfx contract smoke',
  );
  if (contract === undefined) return;
  const repoContract = path.join(
    ROOT,
    'framework',
    'kfx',
    'kungfu-kfx.contract.json',
  );
  const expectedHash = `sha256:${sha256(repoContract)}`;
  if (contract?.id === 'kungfu-kfx' && contract?.hash === expectedHash) {
    pass('kungfu kfx contract smoke', expectedHash);
  } else {
    fail(
      'kungfu kfx contract smoke',
      `id ${contract?.id || '<missing>'}, hash ${contract?.hash || '<missing>'} != ${expectedHash}`,
    );
  }
}

function verifySkillContract(kungfuBin) {
  const contract = runKungfuJson(
    kungfuBin,
    ['skill', 'contract', '--json'],
    'kungfu skill contract smoke',
  );
  if (contract === undefined) return;
  const repoContract = path.join(
    ROOT,
    'framework',
    'skill',
    'kungfu-skill.contract.json',
  );
  const expectedHash = `sha256:${sha256(repoContract)}`;
  if (contract?.id === 'kungfu-skill' && contract?.hash === expectedHash) {
    pass('kungfu skill contract smoke', expectedHash);
  } else {
    fail(
      'kungfu skill contract smoke',
      `id ${contract?.id || '<missing>'}, hash ${contract?.hash || '<missing>'} != ${expectedHash}`,
    );
  }
}

function verifyContractRegistry(kungfuBin) {
  const verified = runKungfuJson(
    kungfuBin,
    ['contract', 'verify', '--json'],
    'kungfu contract registry smoke',
  );
  if (verified === undefined) return;
  if (verified?.ok && verified?.contracts?.length >= 3) {
    pass(
      'kungfu contract registry smoke',
      `${verified.contracts.length} contracts verified`,
    );
  } else {
    fail(
      'kungfu contract registry smoke',
      `ok=${String(verified?.ok)} contracts=${String(verified?.contracts?.length ?? '<missing>')}`,
    );
  }
}

function failMissingKungfuRuntime() {
  fail('kungfu runtime smoke', 'no kungfu executable, skipped');
  fail('kungfu config contract smoke', 'no kungfu executable, skipped');
  fail('kungfu kfx contract smoke', 'no kungfu executable, skipped');
  fail('kungfu skill contract smoke', 'no kungfu executable, skipped');
  fail('kungfu contract registry smoke', 'no kungfu executable, skipped');
}

function verifyKungfuRuntime(kungfuBin, version) {
  // ── Stage 3: kungfu runtime smoke ────────────────────────────────────
  console.log('\n[verify] stage 3: kungfu runtime smoke (kungfu --version)');
  if (kungfuBin) {
    verifyRuntimeVersion(kungfuBin, version);
    verifyConfigContract(kungfuBin);
    verifyKfxContract(kungfuBin);
    verifySkillContract(kungfuBin);
    verifyContractRegistry(kungfuBin);
  } else {
    failMissingKungfuRuntime();
  }
  runEpisodeQualificationSmoke();
}
function verifyAppArtifact() {
  // ── Stage 4: (optional) app build artifact ────────────────────────
  if (withApp) {
    console.log('\n[verify] stage 4: app build artifact assertion');
    const appOut = path.join(ROOT, 'framework', 'gui', 'out');
    const requiredAppArtifacts = [
      'main/index.js',
      'preload/sandbox.js',
      'renderer/index.html',
    ];
    const missing = requiredAppArtifacts.filter(
      (rel) => !fs.existsSync(path.join(appOut, rel)),
    );
    if (
      missing.length === 0 &&
      fs.existsSync(appOut) &&
      fs.statSync(appOut).isDirectory()
    ) {
      pass('build:app artifact exists', path.relative(ROOT, appOut));
    } else {
      fail(
        'build:app artifact exists',
        `missing ${missing.join(', ') || path.relative(ROOT, appOut)} (build:app first)`,
      );
    }
  }
}

function verifyJournalFixtures() {
  console.log('\n[verify] stage 6: journal fact fixtures');
  const fixturePrefixes = [
    'rewind-demo-',
    'work-demo-',
    'agent-demo-',
    'atlas-demo-',
    'kfx-demo-',
    'storage-demo-',
  ];
  const fixturesDir = path.join(ROOT, 'tests', 'fixtures');
  const fixtures = fs.existsSync(fixturesDir)
    ? fs
        .readdirSync(fixturesDir)
        .filter(
          (directory) =>
            fixturePrefixes.some((prefix) => directory.startsWith(prefix)) &&
            runnerFor(path.join(fixturesDir, directory)),
        )
        .sort()
    : [];
  for (const name of fixtures) {
    const runner = runnerFor(path.join(fixturesDir, name));
    const result = spawnSync(runner.cmd, runner.args, { encoding: 'utf8' });
    if (result.status === 0) {
      pass(`fixture ${name}`, 'journal facts hold');
    } else {
      fail(
        `fixture ${name}`,
        `${runner.label} exit ${exitLabel(result.status, result.signal)}; tail: ${outputTail(
          result.stdout,
          result.stderr,
          24,
        ).slice(0, 2400)}`,
      );
    }
  }
}

function verifyCapabilities() {
  // ── Stage 5: capability slices (full mode) ────────────────────────
  // Each slice under framework/core/slices/ is a standalone proof of a core
  // capability (see slices/README.md); a red slice means a capability the
  // repo depends on has regressed. Built and run only in --full so the quick
  // path keeps its seconds-level semantics.
  if (doFull) {
    console.log('\n[verify] stage 5: capability slices');
    if (isWin) {
      console.log(
        '  (skipped on Windows: slice probes are bash scripts; not asserted on this platform)',
      );
    } else {
      const core = path.join(ROOT, 'framework', 'core');
      const buildDir = path.join(core, 'build');
      const slicesDir = path.join(core, 'slices');
      const cfg = spawnSync(
        'cmake',
        ['-S', core, '-B', buildDir, '-DKUNGFU_WITH_SLICES=ON'],
        { stdio: 'inherit' },
      );
      if (cfg.status !== 0) {
        fail(
          'slices configure',
          `cmake -DKUNGFU_WITH_SLICES=ON failed (exit ${cfg.status}); rebuild:core must run first to seed the build tree`,
        );
        return summarize();
      }
      const bld = spawnSync('cmake', ['--build', buildDir], {
        stdio: 'inherit',
      });
      if (bld.status !== 0) {
        fail('slices build', `cmake --build failed (exit ${bld.status})`);
        return summarize();
      }
      pass('slices build', 'KUNGFU_WITH_SLICES=ON');
      /** @param {import('child_process').SpawnSyncReturns<string>} r */
      const tail3 = (r) =>
        `${r.stdout || ''}${r.stderr || ''}`
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ')
          .slice(0, 300);
      const slices = fs
        .readdirSync(slicesDir)
        .filter((d) => runnerFor(path.join(slicesDir, d)))
        .sort();
      for (const name of slices) {
        const runner = runnerFor(path.join(slicesDir, name));
        const r = spawnSync(runner.cmd, [...runner.args, buildDir], {
          encoding: 'utf8',
        });
        if (r.status === 0) pass(`slice ${name}`, 'proof holds');
        else
          fail(
            `slice ${name}`,
            `${runner.label} exit ${exitLabel(r.status, r.signal)}; tail: ${tail3(r)}`,
          );
      }
      const guardMjs = path.join(core, 'src', 'libyijinjing', 'check-deps.mjs');
      const guard = spawnSync(process.execPath, [guardMjs], {
        encoding: 'utf8',
      });
      if (guard.status === 0) pass('yijinjing dependency guard', 'check-deps');
      else fail('yijinjing dependency guard', tail3(guard));

      // KF-ADR-019f86da-4f90-738c-b372-e509976f69ff: the guard itself must demonstrably fail on a seeded
      // engine include/symbol/link; a guard that cannot fail is not a gate.
      const guardSelfTest = spawnSync(
        process.execPath,
        [guardMjs, '--self-test'],
        {
          encoding: 'utf8',
        },
      );
      if (guardSelfTest.status === 0)
        pass('yijinjing dependency guard self-test', 'seeded violations fail');
      else fail('yijinjing dependency guard self-test', tail3(guardSelfTest));

      // KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc: all FlatBuffers/reflection access is confined to kungfu::view.
      const viewGuardMjs = path.join(
        core,
        'src',
        'libkungfu',
        'check-view-boundary.mjs',
      );
      const viewGuard = spawnSync(process.execPath, [viewGuardMjs], {
        encoding: 'utf8',
      });
      if (viewGuard.status === 0)
        pass('kungfu::view FB boundary guard', 'check-view-boundary');
      else fail('kungfu::view FB boundary guard', tail3(viewGuard));

      verifyJournalFixtures();
    }
  }
}

function memorySafetyTail(result) {
  return `${result.stdout || ''}${result.stderr || ''}`
    .trim()
    .split('\n')
    .slice(-3)
    .join(' | ')
    .slice(0, 400);
}

function verifySanitizerReplay(context) {
  const { core, fuzzSrc, cmakePrefix, targets } = context;
  const tail3 = memorySafetyTail;
  const buildDir = path.join(core, 'build-sanitize');
  const cfg = spawnSync(
    'cmake',
    [
      '-S',
      fuzzSrc,
      '-B',
      buildDir,
      '-DKUNGFU_WITH_SANITIZERS=ON',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_PREFIX_PATH=${cmakePrefix}`,
      `-DCMAKE_MODULE_PATH=${cmakePrefix}`,
    ],
    { stdio: 'inherit' },
  );
  if (cfg.status !== 0) {
    fail(
      'view ASan/UBSan configure',
      `cmake -DKUNGFU_WITH_SANITIZERS=ON failed (exit ${cfg.status})`,
    );
  } else {
    const bld = spawnSync(
      'cmake',
      ['--build', buildDir, '--config', 'Release'],
      {
        stdio: 'inherit',
      },
    );
    if (bld.status !== 0)
      fail(
        'view ASan/UBSan build',
        `cmake --build failed (exit ${bld.status})`,
      );
    else {
      pass('view ASan/UBSan build', 'KUNGFU_WITH_SANITIZERS=ON');
      for (const t of targets) {
        const bin = builtBin(buildDir, `fuzz_${t}_sanitize`);
        if (!bin) {
          fail(
            `view ASan replay ${t}`,
            `binary missing under ${path.relative(ROOT, buildDir)}`,
          );
          continue;
        }
        const corpus = path.join(fuzzSrc, 'corpus', t);
        const r = spawnSync(bin, [corpus], { encoding: 'utf8' });
        if (r.status === 0)
          pass(`view ASan replay ${t}`, 'corpus clean under ASan+UBSan');
        else
          fail(
            `view ASan replay ${t}`,
            `exit ${exitLabel(r.status, r.signal)}; tail: ${tail3(r)}`,
          );
      }
    }
  }
}

function runFuzzTargets(context, buildDir, built) {
  const { fuzzSrc, targets } = context;
  pass(
    'view fuzz build',
    `KUNGFU_WITH_FUZZ=ON (${built.length}/${targets.length} targets)`,
  );
  const secs = Number(process.env.KUNGFU_FUZZ_SECONDS || '20');
  for (const target of built) {
    const bin = builtBin(buildDir, `fuzz_${target}`);
    const seeds = path.join(fuzzSrc, 'corpus', target);
    const work = path.join(buildDir, 'work', target);
    const artifacts = path.join(buildDir, 'artifacts', target);
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });
    if (fs.existsSync(seeds)) {
      for (const file of fs.readdirSync(seeds)) {
        fs.copyFileSync(path.join(seeds, file), path.join(work, file));
      }
    }
    const result = spawnSync(
      bin,
      [
        work,
        `-max_total_time=${secs}`,
        `-artifact_prefix=${artifacts}${path.sep}`,
        '-print_final_stats=1',
      ],
      { encoding: 'utf8' },
    );
    if (result.status === 0) {
      pass(`view fuzz ${target}`, `${secs}s, no crash`);
    } else {
      fail(
        `view fuzz ${target}`,
        `crash — reproducer under ${path.relative(ROOT, artifacts)}; exit ${exitLabel(result.status, result.signal)}; tail: ${memorySafetyTail(result)}`,
      );
    }
  }
}

function verifyFuzzLongRun(context) {
  const { core, fuzzSrc, cmakePrefix, targets } = context;
  // Tier 2 — libFuzzer long-run (alpha/release gate). Needs a libFuzzer clang.
  if (doFuzz) {
    const clang = fuzzClang();
    const buildDir = path.join(core, 'build-fuzz');
    const cfgArgs = [
      '-S',
      fuzzSrc,
      '-B',
      buildDir,
      '-DKUNGFU_WITH_FUZZ=ON',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_PREFIX_PATH=${cmakePrefix}`,
      `-DCMAKE_MODULE_PATH=${cmakePrefix}`,
    ];
    if (clang) cfgArgs.push(`-DCMAKE_CXX_COMPILER=${clang}`);
    const cfg = spawnSync('cmake', cfgArgs, { stdio: 'inherit' });
    if (cfg.status !== 0) {
      fail(
        'view fuzz configure',
        `cmake -DKUNGFU_WITH_FUZZ=ON failed (exit ${cfg.status})`,
      );
    } else {
      const bld = spawnSync(
        'cmake',
        ['--build', buildDir, '--config', 'Release'],
        {
          stdio: 'inherit',
        },
      );
      if (bld.status !== 0) {
        fail('view fuzz build', `cmake --build failed (exit ${bld.status})`);
      } else {
        const built = targets.filter((t) => builtBin(buildDir, `fuzz_${t}`));
        if (built.length === 0) {
          // No libFuzzer in the active clang. Linux clang ships it, so on the
          // Linux alpha runner this is a real gate failure, not a skip. On
          // macOS/Windows libFuzzer is not always present; the sanitizer tier
          // above already exercised ASan/UBSan, so soft-skip the long-run there
          // rather than break the platform's build.
          if (process.platform === 'linux') {
            fail(
              'view fuzz targets',
              `no libFuzzer targets built on Linux (clang '${clang || 'default'}' lacks -fsanitize=fuzzer); the Linux alpha gate requires libFuzzer. Set KUNGFU_FUZZ_CLANGXX to an LLVM clang.`,
            );
          } else {
            console.log(
              `  (skipped: no libFuzzer clang on ${process.platform}; ASan/UBSan tier above covered the entries. brew install llvm or set KUNGFU_FUZZ_CLANGXX to enable the long-run here.)`,
            );
          }
        } else {
          runFuzzTargets(context, buildDir, built);
        }
      }
    }
  }
}

function verifyMemorySafety() {
  // ── Stage 7: kungfu::view memory safety (ASan/UBSan + libFuzzer) ───
  if (!doFull && !doFuzz) return true;
  console.log(
    '\n[verify] stage 7: kungfu::view memory safety (ASan/UBSan + fuzz)',
  );
  const core = path.join(ROOT, 'framework', 'core');
  const fuzzSrc = path.join(core, 'fuzz');
  const prefix = conanPrefix(core);
  const cmakePrefix = prefix?.replaceAll('\\', '/');
  const targets = fs.existsSync(fuzzSrc)
    ? fs
        .readdirSync(fuzzSrc)
        .map((file) => /^fuzz_(.+)\.cpp$/.exec(file))
        .filter((match) => match)
        .map((match) => match[1])
        .sort()
    : [];
  if (!prefix) {
    fail(
      'view memory-safety deps',
      `conan CMakeDeps not found under ${path.join(core, 'build')}; rebuild:core must run first (use --full)`,
    );
    return false;
  }
  const context = { core, fuzzSrc, cmakePrefix, targets };
  verifySanitizerReplay(context);
  verifyFuzzLongRun(context);
  return true;
}
function main() {
  const version = expectedVersion();
  console.log(
    `[verify] kungfu build-chain verification — expected version ${version}`,
  );
  console.log(
    `[verify] mode: ${doFull ? 'full (build first)' : 'quick (assert existing artifacts only)'}${withApp ? ' + app' : ''}${skipEpisodeQualification ? ' - Episode qualification' : ' + Episode qualification'}`,
  );

  verifyShifuEntryContract();
  verifyNoBashGuard();
  verifyGateCatalog();
  verifyPythonTypes();
  verifyAgentPack();
  verifyKfd2Claims();
  verifyBuildchainKfdEvidence();
  verifyToolchain();
  if (!runBuildStage()) return summarize();
  const kungfuBin = verifyKungfuArtifacts();
  verifyCppProbe();
  verifyPythonProbe();
  verifyKungfuRuntime(kungfuBin, version);
  verifyAppArtifact();
  verifyCapabilities();
  if (!verifyMemorySafety()) return summarize();
  return summarize();
}

// conan CMakeDeps (flatbuffers / SQLite configs) are generated into
// framework/core/build by build:core / rebuild:core; the standalone fuzz build
// reuses them via CMAKE_PREFIX_PATH so it need not re-resolve conan itself.
function conanPrefix(core) {
  const build = path.join(core, 'build');
  const markers = [
    'flatbuffers-config.cmake',
    'Findflatbuffers.cmake',
    'FlatBuffersConfig.cmake',
  ];
  return markers.some((m) => fs.existsSync(path.join(build, m))) ? build : null;
}

// Locate a built executable across single-config (Ninja/Make: buildDir/<name>)
// and multi-config (VS: buildDir/Release/<name>.exe) generator layouts.
function builtBin(buildDir, name) {
  const cands = [
    path.join(buildDir, name),
    path.join(buildDir, `${name}.exe`),
    path.join(buildDir, 'Release', name),
    path.join(buildDir, 'Release', `${name}.exe`),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

// libFuzzer needs an LLVM clang; Apple clang has none. Honor an explicit
// override, else prefer Homebrew LLVM (macOS), else on Linux prefer clang++
// (system clang ships libFuzzer) over a possibly-gcc default. Returns null to
// mean "let CMake pick its default compiler".
function fuzzClang() {
  if (process.env.KUNGFU_FUZZ_CLANGXX) return process.env.KUNGFU_FUZZ_CLANGXX;
  const cands = [
    '/opt/homebrew/opt/llvm/bin/clang++',
    '/usr/local/opt/llvm/bin/clang++',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  if (process.platform === 'linux') return 'clang++';
  return null;
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n[verify] result: ${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length) {
    console.error(
      `[verify] ❌ verification failed (${failed.length} item(s)): ${failed.map((r) => r.name).join(', ')}`,
    );
    process.exit(1);
  }
  console.log('[verify] ✅ build-chain end-to-end verification passed');
  process.exit(0);
}

main();
