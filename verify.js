// SPDX-License-Identifier: Apache-2.0
//
// verify — end-to-end "green" verification of the kungfu build chain (modernization assessment spec B3)
//
// Converges the Phase 1 gate — previously run by hand across scattered steps (freeze → build:core →
// build:app → launch app) with no single criterion — into a reproducible "one command + assert
// artifacts" criterion, which also serves as a CI smoke baseline.
//
// Usage (node pinned via the entrypoint; plain `node verify.js` also works):
//   ./kungfu-code verify              quick: only assert "existing" artifacts (dist/kfc exists + kfc runs + version matches)
//   ./kungfu-code verify --full       full: rebuild:core + freeze first, then assert; also builds and runs the
//                                     capability slices (framework/core/slices) + yijinjing dependency guard
//   ./kungfu-code verify --with-app   also assert the build:app artifact (with --full it builds the app first)
//   ./kungfu-code verify --help
//
// Assertion targets (all grounded in the build scripts, not guessed):
//   - framework/core/dist/kfc/                     freeze artifact directory (run-freeze.js renameSync target)
//   - framework/core/dist/kfc/kfc[.exe]           kfc executable (path resolved by lib/executable.js)
//   - `kfc --version` exits 0 and output contains the expected version   frozen Python runtime runs end to end (runtime smoke)
//   - framework/gui/dist/app/                      (--with-app) build:app webpack artifact
//
// Exit codes: all green 0; any failed assertion 1 (fail-fast prints copy-pastable troubleshooting info).
// Note: an Electron app's "interactive launch" cannot be asserted in a headless environment, so kfc
// runtime smoke + app build artifact existence serve as the machine-assertable equivalent; the real
// window launch is left as a manual / CI-display step.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const isWin = process.platform === 'win32';

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

// expected version: single source of truth is lerna.json (the version maintained by the org repo action-bump-version)
function expectedVersion() {
  const lerna = JSON.parse(fs.readFileSync(path.join(ROOT, 'lerna.json'), 'utf8'));
  return lerna.version;
}

const results = [];
function pass(name, detail) {
  results.push({ name, ok: true, detail: detail || '' });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  results.push({ name, ok: false, detail: detail || '' });
  console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
}

// run one pnpm task (via the pnpm dispatched by the current node/corepack); throw on failure
function runPnpm(task) {
  console.log(`\n[verify] build stage: pnpm ${task}`);
  const r = spawnSync('pnpm', ['run', task], { cwd: ROOT, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    throw new Error(`pnpm ${task} failed (exit ${r.status == null ? 'signal ' + r.signal : r.status})`);
  }
}

function main() {
  const version = expectedVersion();
  console.log(`[verify] kungfu build-chain verification — expected version ${version}`);
  console.log(`[verify] mode: ${doFull ? 'full (build first)' : 'quick (assert existing artifacts only)'}${withApp ? ' + app' : ''}`);

  // ── Stage 0: toolchain preflight (read-only) ──────────────────────
  console.log('\n[verify] stage 0: toolchain preflight');
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', shell: isWin });
  if (uv.status === 0) pass('uv available', (uv.stdout || '').trim());
  else fail('uv available', 'uv not found (the Python build chain depends on uv); a full build will fail');

  const nodeVersionFile = path.join(ROOT, '.node-version');
  if (fs.existsSync(nodeVersionFile)) {
    const want = fs.readFileSync(nodeVersionFile, 'utf8').trim();
    const got = process.versions.node;
    if (got === want) pass('node version pinned', `v${got}`);
    else fail('node version pinned', `current v${got} ≠ .node-version ${want} (run via ./kungfu-code)`);
  }

  // ── Stage 1: (optional) build ─────────────────────────────────────
  if (doFull) {
    try {
      runPnpm('rebuild:core'); // clean + build:conan C++/wheel/native
      runPnpm('freeze'); // nuitka → framework/core/dist/kfc
      if (withApp) runPnpm('build:app'); // webpack → framework/gui/dist/app
    } catch (e) {
      fail('build stage', e.message);
      return summarize(); // on build failure, wrap up directly and do not assert half-built artifacts
    }
    pass('build stage', 'full chain executed');
  }

  // ── Stage 2: kfc artifact assertions ──────────────────────────────
  console.log('\n[verify] stage 2: kfc artifact assertions');
  const distKfc = path.join(ROOT, 'framework', 'core', 'dist', 'kfc');
  let kfcBin = null;
  if (fs.existsSync(distKfc) && fs.statSync(distKfc).isDirectory()) {
    pass('dist/kfc directory exists', path.relative(ROOT, distKfc));
    kfcBin = path.join(distKfc, isWin ? 'kfc.exe' : 'kfc');
    if (fs.existsSync(kfcBin) && fs.statSync(kfcBin).isFile()) {
      let detail = path.relative(ROOT, kfcBin);
      if (!isWin) {
        const mode = fs.statSync(kfcBin).mode;
        if (!(mode & 0o111)) { fail('kfc executable', `${detail} missing executable bit`); kfcBin = null; }
        else pass('kfc executable exists', detail);
      } else pass('kfc executable exists', detail);
    } else {
      fail('kfc executable exists', `not found ${path.relative(ROOT, kfcBin)} (freeze first)`);
      kfcBin = null;
    }
  } else {
    fail('dist/kfc directory exists', `not found ${path.relative(ROOT, distKfc)} (freeze first; in quick mode, confirm it was built)`);
  }

  // ── Stage 3: kfc runtime smoke ────────────────────────────────────
  console.log('\n[verify] stage 3: kfc runtime smoke (kfc --version)');
  if (kfcBin) {
    const r = spawnSync(kfcBin, ['--version'], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (r.status !== 0) {
      fail('kfc --version exits 0', `exit ${r.status == null ? 'signal ' + r.signal : r.status}; output: ${out.slice(0, 200)}`);
    } else if (!out.includes(version)) {
      fail('kfc version matches', `expected to contain ${version}, got: ${out.slice(0, 200)}`);
    } else {
      pass('kfc runtime smoke', `--version contains ${version}`);
    }
  } else {
    fail('kfc runtime smoke', 'no kfc executable, skipped');
  }

  // ── Stage 4: (optional) app build artifact ────────────────────────
  if (withApp) {
    console.log('\n[verify] stage 4: app build artifact assertion');
    const appDist = path.join(ROOT, 'framework', 'app', 'dist', 'app');
    if (fs.existsSync(appDist) && fs.statSync(appDist).isDirectory() && fs.readdirSync(appDist).length > 0) {
      pass('build:app artifact exists', path.relative(ROOT, appDist));
    } else {
      fail('build:app artifact exists', `non-empty ${path.relative(ROOT, appDist)} not found (build:app first)`);
    }
  }

  // ── Stage 5: capability slices (full mode) ────────────────────────
  // Each slice under framework/core/slices/ is a standalone proof of a core
  // capability (see slices/README.md); a red slice means a capability the
  // repo depends on has regressed. Built and run only in --full so the quick
  // path keeps its seconds-level semantics.
  if (doFull) {
    console.log('\n[verify] stage 5: capability slices');
    if (isWin) {
      console.log('  (skipped on Windows: slice probes are bash scripts; not asserted on this platform)');
    } else {
      const core = path.join(ROOT, 'framework', 'core');
      const buildDir = path.join(core, 'build');
      const slicesDir = path.join(core, 'slices');
      const cfg = spawnSync('cmake', ['-S', core, '-B', buildDir, '-DKUNGFU_WITH_SLICES=ON'], { stdio: 'inherit' });
      if (cfg.status !== 0) {
        fail('slices configure', `cmake -DKUNGFU_WITH_SLICES=ON failed (exit ${cfg.status}); rebuild:core must run first to seed the build tree`);
        return summarize();
      }
      const bld = spawnSync('cmake', ['--build', buildDir], { stdio: 'inherit' });
      if (bld.status !== 0) {
        fail('slices build', `cmake --build failed (exit ${bld.status})`);
        return summarize();
      }
      pass('slices build', 'KUNGFU_WITH_SLICES=ON');
      const tail3 = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      const slices = fs
        .readdirSync(slicesDir)
        .filter((d) => fs.existsSync(path.join(slicesDir, d, 'run.sh')))
        .sort();
      for (const name of slices) {
        const r = spawnSync('bash', [path.join(slicesDir, name, 'run.sh'), buildDir], { encoding: 'utf8' });
        if (r.status === 0) pass(`slice ${name}`, 'proof holds');
        else fail(`slice ${name}`, `run.sh exit ${r.status == null ? 'signal ' + r.signal : r.status}; tail: ${tail3(r)}`);
      }
      const guard = spawnSync('bash', [path.join(core, 'src', 'libyijinjing', 'check-deps.sh')], { encoding: 'utf8' });
      if (guard.status === 0) pass('yijinjing dependency guard', 'check-deps.sh');
      else fail('yijinjing dependency guard', tail3(guard));

      // ── Stage 6: journal fact fixtures (full mode) ────────────────
      // Each fixture under tests/fixtures/rewind-demo-*/ proves a capture
      // gate end to end against the built dist/kfc (G2 capture, G3 event
      // completeness); tests/fixtures/work-demo-*/ prove the default work
      // profile the same way (P1 vocabulary, P2 lifecycle), and
      // tests/fixtures/atlas-demo-*/ prove the read-only control-plane
      // import profile (P7 dogfood slice). A red fixture means the
      // corresponding journal fact contract regressed.
      console.log('\n[verify] stage 6: journal fact fixtures');
      const fixturePrefixes = [
        'rewind-demo-',
        'work-demo-',
        'atlas-demo-',
        'kfx-demo-',
      ];
      const fixturesDir = path.join(ROOT, 'tests', 'fixtures');
      const fixtures = fs.existsSync(fixturesDir)
        ? fs
            .readdirSync(fixturesDir)
            .filter(
              (d) =>
                fixturePrefixes.some((prefix) => d.startsWith(prefix)) &&
                fs.existsSync(path.join(fixturesDir, d, 'run.sh')),
            )
            .sort()
        : [];
      for (const name of fixtures) {
        const r = spawnSync('bash', [path.join(fixturesDir, name, 'run.sh')], { encoding: 'utf8' });
        if (r.status === 0) pass(`fixture ${name}`, 'journal facts hold');
        else fail(`fixture ${name}`, `run.sh exit ${r.status == null ? 'signal ' + r.signal : r.status}; tail: ${tail3(r)}`);
      }
    }
  }

  return summarize();
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify] result: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error(`[verify] ❌ verification failed (${failed.length} item(s)): ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log('[verify] ✅ build-chain end-to-end verification passed');
  process.exit(0);
}

main();
