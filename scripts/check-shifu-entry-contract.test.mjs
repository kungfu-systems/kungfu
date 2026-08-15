// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRoot, scanText } from './check-shifu-entry-contract.mjs';
import {
  assertSourceCheckoutUnchanged,
  prepareSourceAcceptanceRuntime,
  sourceCheckoutSnapshot,
} from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('accepts Shifu commands in participant documentation', () => {
  assert.deepEqual(
    scanText('AGENTS.md', '```sh\n./shifu build\n./shifu check\n```\n'),
    [],
  );
});

test('rejects direct package-manager commands in participant documentation', () => {
  const findings = scanText('AGENTS.md', '```sh\npnpm build\n```\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'pnpm');
  assert.equal(findings[0].line, 2);
});

test('rejects direct node in a workflow run block', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'node');
});

test('allows one explicitly justified implementation command', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      # shifu-entry-contract: allow launcher release bootstrap\n      node scripts/release-launcher.mjs\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
});

test('current participant surfaces satisfy the contract', () => {
  assert.deepEqual(checkRoot(ROOT), []);
});

test('cold source Work failure remains machine-actionable', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-shifu-assignment-'),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launcher = path.join(temp, 'shifu');
  fs.copyFileSync(path.join(ROOT, 'shifu'), launcher);
  fs.chmodSync(launcher, 0o755);

  const result = spawnSync(launcher, ['work', 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temp,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
    },
  });
  assert.equal(result.status, 127);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'kungfu.assignment-orchestration.diagnosis/v1',
    ok: false,
    code: 'assignment-current-checkout-binding-missing',
    message: 'Assignment admission requires pykungfu from the current checkout',
    next_actions: [
      {
        action: 'build-core',
        command: './shifu build:core',
        description: 'Assemble pykungfu from the current checkout',
      },
    ],
  });
});

test('Intel macOS fails before launcher acquisition or task dispatch', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-shifu-intel-mac-'),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launcher = path.join(temp, 'shifu');
  const bin = path.join(temp, 'bin');
  const networkMarker = path.join(temp, 'network-attempted');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(ROOT, 'shifu'), launcher);
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(
    path.join(bin, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n',
  );
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\ntouch ${JSON.stringify(networkMarker)}\nexit 99\n`,
  );
  fs.chmodSync(path.join(bin, 'uname'), 0o755);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);

  const result = spawnSync(launcher, ['build'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temp,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
    },
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'shifu: unsupported-host: Intel macOS (Darwin x86_64) is not supported by Kungfu\n',
  );
  assert.equal(fs.existsSync(networkMarker), false);
});

test('partial Core assembly cannot masquerade as Work readiness', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-shifu-partial-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launcher = path.join(temp, 'shifu');
  const dist = path.join(temp, 'framework', 'core', 'dist', 'kungfu');
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'shifu'), launcher);
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(path.join(dist, 'pykungfu.partial.so'), '');

  const result = spawnSync(launcher, ['work', 'status'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: temp },
  });
  assert.equal(result.status, 127);
  assert.equal(result.stderr, '');
  assert.equal(
    JSON.parse(result.stdout).code,
    'assignment-current-checkout-binding-missing',
  );
});

test('source Kungfu route projects its built TUI and Product extensions', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-shifu-tui-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launcher = path.join(temp, 'shifu');
  const executable = path.join(
    temp,
    'framework',
    'core',
    'dist',
    'kungfu',
    'kungfu',
  );
  const tuiEntry = path.join(temp, 'framework', 'tui', 'dist', 'tui.mjs');
  const extensionRoot = path.join(temp, 'extensions');
  const template = path.join(
    extensionRoot,
    'agent-work-lab',
    'experience',
    'starter-project.json',
  );
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(tuiEntry), { recursive: true });
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'shifu'), launcher);
  fs.writeFileSync(tuiEntry, '');
  fs.writeFileSync(template, '{}\n');
  fs.writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$KUNGFU_TUI_ENTRY"',
      'printf "%s\\n" "$KF_BUNDLED_EXTENSION_ROOT"',
      'printf "%s\\n" "$*"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(executable, 0o755);

  const result = spawnSync(
    launcher,
    ['kungfu', 'agent-work-lab', 'project-tour'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        KUNGFU_TUI_ENTRY: '',
        KF_BUNDLED_EXTENSION_ROOT: '',
        XDG_CONFIG_HOME: path.join(temp, 'config'),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    tuiEntry,
    extensionRoot,
    'agent-work-lab project-tour',
  ]);
});

test('Windows source Kungfu route projects built TUI Product paths', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.match(
    windows,
    /if not defined KUNGFU_TUI_ENTRY if exist .*framework\\tui\\dist\\tui\.mjs/u,
  );
  assert.match(
    windows,
    /if not defined KF_BUNDLED_EXTENSION_ROOT if exist .*agent-work-lab\\experience\\starter-project\.json/u,
  );
});

test('cached pinned uv activates Work after Qualified Core materialization', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const cacheTargets = {
    'darwin-arm64': 'macos-aarch64',
    'linux-arm64': 'linux-aarch64',
    'linux-x64': 'linux-x86_64',
  };
  const cacheTarget = cacheTargets[`${process.platform}-${process.arch}`];
  if (!cacheTarget) {
    t.skip('unsupported Shifu bootstrap target');
    return;
  }
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-shifu-cached-uv-'),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launcher = path.join(temp, 'shifu');
  const capture = path.join(temp, 'framework', 'assignment-capture');
  const core = path.join(temp, 'framework', 'core');
  const dist = path.join(core, 'dist', 'kungfu');
  const cache = path.join(temp, 'cache');
  const uv = path.join(
    cache,
    'kungfu',
    'tools',
    'uv',
    '0.11.23',
    cacheTarget,
    'uv',
  );
  const callLog = path.join(temp, 'uv-call.txt');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  fs.mkdirSync(path.dirname(uv), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'shifu'), launcher);
  fs.writeFileSync(
    path.join(capture, 'qualified-assignment-core-consumer.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const binary = path.join(process.env.XDG_CACHE_HOME, 'kungfu', 'tools', 'uv', '0.11.23', process.env.SHIFU_TEST_CACHE_TARGET, 'uv');",
      "if (process.argv[2] === 'resolve-cached-tool' && fs.existsSync(binary)) console.log(binary);",
      '',
    ].join('\n'),
  );
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(path.join(temp, '.uv-version'), '0.11.23\n');
  fs.writeFileSync(path.join(dist, 'pykungfu.cached.so'), '');
  fs.writeFileSync(path.join(dist, 'kungfubuildinfo.json'), '{}\n');
  fs.writeFileSync(
    uv,
    ['#!/bin/sh', 'echo "$PWD|$*" > "$UV_CALL_LOG"', ''].join('\n'),
  );
  fs.chmodSync(uv, 0o755);

  const result = spawnSync(launcher, ['work', '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temp,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      SHIFU_TEST_CACHE_TARGET: cacheTarget,
      UV_CALL_LOG: callLog,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.readFileSync(callLog, 'utf8'),
    `${core}|run --frozen python .devtools/kungfu_cli.py work --help\n`,
  );
  fs.rmSync(callLog);
  const rejected = spawnSync(launcher, ['work', '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temp,
      KUNGFU_UV_VERSION: '../0.11.23',
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      SHIFU_TEST_CACHE_TARGET: 'invalid-target',
      UV_CALL_LOG: callLog,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
    },
  });
  assert.equal(rejected.status, 127);
  assert.equal(fs.existsSync(callLog), false);
});

test('Windows cold source Work failure carries the same diagnosis', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.match(
    windows,
    /"code":"assignment-current-checkout-binding-missing"/u,
  );
  assert.match(windows, /"action":"build-core"/u);
  assert.match(windows, /"command":"shifu\.cmd build:core"/u);
  assert.match(windows, /kungfubuildinfo\.json/u);
  assert.match(
    windows,
    /qualified-assignment-core-consumer\.mjs" materialize/u,
  );
  assert.match(windows, /resolve-cached-tool uv/u);
  assert.match(windows, /set "_KFC_UV=/u);
});

test('cache execution boundaries distinguish gate run and source acceptance', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const native = fs.readFileSync(
    path.join(ROOT, 'crates', 'shifu', 'src', 'main.rs'),
    'utf8',
  );

  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /SHIFU_CACHE_BYPASS/);
    assert.match(entrypoint, /source-acceptance/);
    assert.match(entrypoint, /shifu-cache-entry: source-acceptance-bypass/);
    assert.match(entrypoint, /shifu-cache-entry: gate-run-outer-apply/);
  }
  assert.match(windows, /source-acceptance\.mjs/);
  assert.match(native, /gate_subcommand/);
  assert.match(native, /cache_bypass/);
});

test('ordinary Windows commands bypass source acceptance and reach native dispatch', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const sourceAcceptance = windows.match(
    /:sourceacceptance[\s\S]*?(?=\r?\n:readonlynode\r?\n)/u,
  )?.[0];
  assert.ok(sourceAcceptance, 'Windows source acceptance block is missing');
  assert.match(
    sourceAcceptance,
    /if \/i not "%~1"=="check:source" goto native/u,
  );
  assert.match(sourceAcceptance, /source-acceptance\.mjs/u);
});

test('build-free read-only routes bypass launcher bootstrap on both shims', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /core:architecture/);
    assert.match(entrypoint, /core:architecture:health/);
    assert.match(entrypoint, /invariant:verify/);
    assert.match(entrypoint, /maintainability:complexity/u);
    assert.match(entrypoint, /maintainability:amplification/u);
    assert.match(entrypoint, /maintainability:query/u);
    assert.match(entrypoint, /kfd:query/u);
    assert.match(entrypoint, /kfd:support-matrix:check/u);
    assert.match(entrypoint, /shifu-readonly-entry\.mjs/u);
    assert.match(entrypoint, /readonly-node-unavailable/u);
  }
  const posixFloor = posix.slice(
    posix.indexOf('# Build-free routes'),
    posix.indexOf('# Source acceptance'),
  );
  assert.doesNotMatch(posixFloor, /fnm install|pnpm|diagnostics/u);
  const windowsFloor = windows.slice(
    windows.indexOf(':readonlynode'),
    windows.indexOf(':kungfucli'),
  );
  assert.doesNotMatch(windowsFloor, /fnm install|pnpm|diagnostics/u);
});

test('work-design Work Design preflight is build-free on both shims', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const readonly = fs.readFileSync(
    path.join(ROOT, 'scripts/shifu-readonly-entry.mjs'),
    'utf8',
  );
  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /work-design:preflight/u);
    assert.match(entrypoint, /shifu-readonly-entry\.mjs/u);
  }
  assert.match(
    readonly,
    /framework[\\/]work-design-preflight[\\/]tooling[\\/]work-design-preflight\.mjs/u,
  );
  assert.doesNotMatch(
    readonly,
    /fnm install|pnpm|\.buildchain[\\/]diagnostics/u,
  );
});

test('Work Design outcome feedback and status are build-free on both shims', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const readonly = fs.readFileSync(
    path.join(ROOT, 'scripts/shifu-readonly-entry.mjs'),
    'utf8',
  );
  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /work-design:feedback/u);
    assert.match(entrypoint, /shifu-readonly-entry\.mjs/u);
  }
  assert.match(
    readonly,
    /framework[\\/]work-design-policy-replay[\\/]tooling[\\/]check-work-design-policy-replay\.mjs/u,
  );
  assert.doesNotMatch(
    readonly,
    /fnm install|pnpm|\.buildchain[\\/]diagnostics/u,
  );
});

test('Xinfa product tasks bypass unrelated Kungfu dependency caches', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /shifu-xinfa-entry: cache-independent/);
    assert.match(entrypoint, /xinfa[\\/]tooling[\\/]task\.mjs/);
    for (const task of ['build', 'check', 'standalone']) {
      assert.match(entrypoint, new RegExp(`xinfa:${task}`));
    }
  }
});

test('Xinfa source entry prefers hash-pinned wasm and preserves native fallback', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  for (const entrypoint of [posix, windows]) {
    assert.match(
      entrypoint,
      /shifu-xinfa-source-entry: hash-pinned-wasm-with-native-fallback/,
    );
    assert.match(entrypoint, /wasm-host\.mjs/);
    assert.match(entrypoint, /--engine-status/);
    assert.match(entrypoint, /falling back to the native/);
    assert.match(
      entrypoint,
      /cargo run --locked --quiet --manifest-path crates[\\/]Cargo\.toml -p kungfu-trunk -- xinfa --source-argv/,
    );
    assert.match(entrypoint, /XINFA_CARGO_TARGET_DIR/);
  }
});

test('Xinfa quality uses the source resolver and forwards one Windows mode', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const posixBlock = posix.match(/xinfa:quality\)[\s\S]*?;;/u)?.[0];
  const windowsBlock = windows.match(
    /:xinfaquality[\s\S]*?(?=\r?\n:projectcut\r?\n)/u,
  )?.[0];
  const routeIndex = windows.indexOf(
    'if /i "%~1"=="xinfa:quality" goto xinfaquality',
  );
  const qualityIndex = windows.indexOf('\n:xinfaquality\n');
  const projectCutIndex = windows.indexOf('\n:projectcut\n');
  assert.ok(posixBlock, 'POSIX Xinfa quality block is missing');
  assert.ok(windowsBlock, 'Windows Xinfa quality block is missing');
  assert.ok(routeIndex >= 0, 'Windows Xinfa quality route is missing');
  assert.ok(
    qualityIndex > routeIndex && qualityIndex < projectCutIndex,
    'Windows Xinfa quality target must stay adjacent to the route table',
  );
  assert.match(
    windows.slice(routeIndex, qualityIndex),
    /goto projectcut\r?\n\s*$/u,
    'ordinary Windows commands must bypass the adjacent quality target',
  );
  assert.match(
    windowsBlock,
    /if \/i not "%~1"=="xinfa:quality" goto projectcut/u,
  );
  assert.doesNotMatch(posixBlock, /xinfa\/tooling\/task\.mjs build/u);
  assert.doesNotMatch(windowsBlock, /xinfa\\tooling\\task\.mjs" build/u);
  assert.match(windowsBlock, /%~2/u);
  assert.match(windowsBlock, /"%_XINFA_QUALITY_MODE%"/u);
  assert.doesNotMatch(windowsBlock, /\s%\*/u);
});

test('Windows source-fresh launcher retries one transient build failure', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const sourceBuild = windows.match(
    /echo shifu: building launcher from source[\s\S]*?echo shifu: source build failed; falling back/,
  )?.[0];
  assert.ok(sourceBuild, 'Windows source-build block is missing');
  assert.equal(
    sourceBuild.match(
      /cargo build --release --locked --manifest-path crates\\Cargo\.toml -p shifu/g,
    )?.length,
    2,
  );
  assert.match(sourceBuild, /_KFC_BUILD_ERROR=!errorlevel!/);
  assert.match(sourceBuild, /_KFC_TGT=!_KFC_TGT!-retry-!RANDOM!-!RANDOM!/);
  assert.match(sourceBuild, /ping -n 3 127\.0\.0\.1/);
  assert.match(sourceBuild, /if "!_KFC_BUILD_ERROR!"=="0" \(/);
});

test('Windows local environment parsing is inline and label-free', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.match(
    windows,
    /for %%f in \("%_KFC_USERCFG%" "\.\\build-local\.env"\) do if exist "%%~f"/u,
  );
  assert.match(windows, /findstr \/b \/c:"export " "%%~f"/u);
  assert.doesNotMatch(windows, /call :loadenv|^:loadenv$/mu);
});

test('source-fresh launchers pin nested Shifu entry to the resolved binary', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.ok(
    posix.match(/SHIFU_BIN="\$kungfu_dev_bin" exec "\$kungfu_dev_bin"/g)
      ?.length >= 2,
  );
  assert.match(windows, /set "SHIFU_BIN=%_KFC_DEVBIN%"/u);
  assert.match(windows, /set "_KFC_SOURCE_BIN=%_KFC_DEVBIN%"/u);
  assert.match(windows, /set "SHIFU_BIN=%_KFC_SOURCE_BIN%"/u);
});

test('cold source acquisition copies the binary from its isolated Cargo target', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const posixAcquire = posix.match(
    /kungfu_native_acquire\(\) \{[\s\S]*?^\}/mu,
  )?.[0];
  const windowsAcquire = windows.match(/:acquire[\s\S]*?:inscript/u)?.[0];
  assert.ok(posixAcquire, 'POSIX cold-acquire block is missing');
  assert.ok(windowsAcquire, 'Windows cold-acquire block is missing');
  assert.match(
    posixAcquire,
    /CARGO_TARGET_DIR="\$_tgt" cargo build --release --locked/,
  );
  assert.match(posixAcquire, /_built="\$_tgt\/release\//);
  assert.doesNotMatch(posixAcquire, /crates\/target\/release/);
  assert.match(windowsAcquire, /_KFC_ACQUIRE_TGT=/);
  assert.match(windowsAcquire, /set "CARGO_TARGET_DIR=!_KFC_ACQUIRE_TGT!"/);
  assert.match(windowsAcquire, /cargo build --release --locked/);
  assert.match(windowsAcquire, /!_KFC_ACQUIRE_TGT!\\release\\shifu\.exe/);
  assert.doesNotMatch(windowsAcquire, /crates\\target\\release/);
});

test('Windows launchers dispatch after resolution blocks and preserve arguments', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.match(
    windows,
    /if defined SHIFU_BIN if exist "%SHIFU_BIN%" \(\s+"%SHIFU_BIN%" %\*\s+exit \/b !errorlevel!/u,
  );
  assert.match(
    windows,
    /if not defined _KFC_DIRTY if exist "%_KFC_DEVBIN%" \([\s\S]*?"%_KFC_DEVBIN%" %\*\s+exit \/b !errorlevel!/u,
  );
  assert.match(
    windows,
    /set "_KFC_SOURCE_BIN=!_KFC_TGT!\\release\\shifu\.exe"/u,
  );
  assert.match(
    windows,
    /if not defined _KFC_SOURCE_BIN goto sourcebuildfailed\s+set "SHIFU_BIN=%_KFC_SOURCE_BIN%"\s+"%_KFC_SOURCE_BIN%" %\*\s+exit \/b !errorlevel!/u,
  );
  assert.doesNotMatch(windows, /^\s+"!_KFC_DEVBIN!" %\*/gmu);
  assert.ok(windows.match(/^\s+"(?:%|!)_KFC_BIN(?:%|!)" %\*/gmu)?.length >= 3);
  assert.doesNotMatch(windows, /:runresolved/u);
});

test('runtime guard rejects a direct task and accepts Shifu provenance', () => {
  const guard = path.join(ROOT, 'scripts', 'require-shifu.mjs');
  const rejected = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '' },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Run: \.\/shifu build:core/);

  const accepted = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '1' },
  });
  assert.equal(accepted.status, 0);
});

test('real package manager cannot run a guarded task or write the checkout', (t) => {
  const runtime = prepareSourceAcceptanceRuntime(ROOT);
  t.after(runtime.cleanup);
  const before = sourceCheckoutSnapshot(ROOT);
  const fixture = fs.mkdtempSync(
    path.join(runtime.runtimeRoot, 'kungfu-package-manager-guard-'),
  );
  const guard = path.join(ROOT, 'scripts', 'require-shifu.mjs');
  // cmd.exe reparses a quoted executable in the first package-script token.
  // Resolve the current Node through PATH on Windows so the guard itself runs.
  const node =
    process.platform === 'win32'
      ? path.basename(process.execPath)
      : JSON.stringify(process.execPath);
  const guardPath = JSON.stringify(guard);
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    `${JSON.stringify(
      {
        name: 'kungfu-package-manager-guard-fixture',
        private: true,
        packageManager: 'pnpm@11.7.0',
        scripts: {
          'check:entry-contract': `${node} ${guardPath} check:entry-contract`,
        },
      },
      null,
      2,
    )}\n`,
  );
  const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const direct = spawnSync(corepack, ['pnpm', 'run', 'check:entry-contract'], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...runtime.env, SHIFU_ENTRYPOINT: '' },
    shell: process.platform === 'win32',
  });
  const output = `${direct.stdout}\n${direct.stderr}`;
  assert.equal(direct.status, 1);
  assert.match(output, /Direct package-manager invocation is unsupported/);
  assert.match(
    output,
    /\[shifu-entry\] Run: \.\/shifu (?:install|check:entry-contract)(?:\r?\n|$)/,
  );
  assert.doesNotMatch(output, /\[shifu-entry\] Run: (?:corepack|node|pnpm)\b/);
  assert.equal(
    path.relative(runtime.runtimeRoot, fixture).startsWith('..'),
    false,
  );
  assert.equal(fs.existsSync(path.join(fixture, 'package.json')), true);
  assertSourceCheckoutUnchanged(before, sourceCheckoutSnapshot(ROOT));
});
