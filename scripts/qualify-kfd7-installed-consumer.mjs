// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDumpbinExports } from './kfd7-public-symbols.mjs';
import { assertInstalledBootstrapExports } from './libkungfu-bootstrap-admission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.resolve(
  root,
  process.argv
    .find((value) => value.startsWith('--build-dir='))
    ?.slice('--build-dir='.length) ?? 'framework/core/build',
);
const retain = process.argv.includes('--retain');
const reportPath = process.argv
  .find((value) => value.startsWith('--report='))
  ?.slice('--report='.length);
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-kfd7-installed-consumer-'),
);
const prefix = path.join(scratch, 'install');
const source = path.join(scratch, 'consumer-source');
const consumerBuild = path.join(scratch, 'consumer-build');
const runtimeDir = path.join(scratch, 'runtime');
const streamRoot = path.join(scratch, 'streams');
const sourceStatic = path.join(scratch, 'source-static');
const sourceStaticBuild = path.join(scratch, 'source-static-build');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}`,
    );
  }
  return result.stdout?.trim() ?? '';
}

function findExecutable(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(consumerBuild, `${name}${suffix}`),
    path.join(consumerBuild, 'Release', `${name}${suffix}`),
  ];
  const result = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(result, `missing external consumer executable ${name}`);
  return result;
}

function runtimeEnvironment() {
  const env = { ...process.env };
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.join(prefix, 'lib'), env.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':');
  } else if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [path.join(prefix, 'lib'), env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':');
  } else if (process.platform === 'win32') {
    env.PATH = [path.join(prefix, 'bin'), env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
  }
  return env;
}

function publicSymbols(library) {
  if (process.platform === 'darwin') {
    return run('nm', ['-gU', library], { capture: true })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).at(-1).replace(/^_/, ''));
  }
  if (process.platform === 'linux') {
    return run('nm', ['-D', '--defined-only', library], { capture: true })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).at(-1).split('@')[0]);
  }
  const output = run('dumpbin', ['/nologo', '/exports', library], {
    capture: true,
  });
  return parseDumpbinExports(output);
}

try {
  assert.ok(
    fs.existsSync(buildDir),
    `core build directory does not exist: ${buildDir}`,
  );
  run('cmake', [
    '--install',
    buildDir,
    '--config',
    'Release',
    '--prefix',
    prefix,
  ]);
  fs.cpSync(path.join(root, 'framework/core/examples/kfd7-consumer'), source, {
    recursive: true,
  });
  run('cmake', [
    '-S',
    source,
    '-B',
    consumerBuild,
    `-DCMAKE_PREFIX_PATH=${prefix}`,
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
  run('cmake', ['--build', consumerBuild, '--config', 'Release']);

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(streamRoot, { recursive: true });
  const env = runtimeEnvironment();
  const reports = [
    JSON.parse(
      run(findExecutable('kungfu_kfd7_c_consumer'), [runtimeDir, streamRoot], {
        cwd: scratch,
        env,
        capture: true,
      }),
    ),
    JSON.parse(
      run(
        findExecutable('kungfu_kfd7_cpp_consumer'),
        [runtimeDir, streamRoot],
        {
          cwd: scratch,
          env,
          capture: true,
        },
      ),
    ),
  ];

  assert.deepEqual(
    reports.map((report) => report.consumer),
    ['c', 'cpp'],
  );
  for (const report of reports) {
    assert.equal(report.abi, 1);
    assert.equal(report.interfaces, 4);
    assert.equal(report.runtime, 'libkungfu');
    assert.equal(report.version, '4.0.0-alpha.3');
  }
  assert.equal(
    reports[0].binding_root,
    'sha256:c156cb56fc16603689f6b875985ed7b7d92bec5d5d5b76adc2f75c67fabb3739',
  );

  const installedContract = JSON.parse(
    fs.readFileSync(
      path.join(
        prefix,
        'share/kungfu/contracts/kfd7-library-boundary.contract.json',
      ),
      'utf8',
    ),
  );
  assert.equal(
    installedContract.successorAbi.bootstrap.symbol,
    'kungfu_get_api',
  );
  assert.equal(installedContract.successorAbi.interfaces.length, 4);
  const symbolPolicy = JSON.parse(
    fs.readFileSync(
      path.join(prefix, 'share/kungfu/contracts/libkungfu-symbol-policy.json'),
      'utf8',
    ),
  );
  const conformance = JSON.parse(
    fs.readFileSync(
      path.join(prefix, 'share/kungfu/contracts/kfd7-abi-conformance-v1.json'),
      'utf8',
    ),
  );
  const operationalSemantics = JSON.parse(
    fs.readFileSync(
      path.join(
        prefix,
        'share/kungfu/contracts/kfd7-embedder-operational-semantics-v1.json',
      ),
      'utf8',
    ),
  );
  const releasePassport = JSON.parse(
    fs.readFileSync(
      path.join(prefix, 'share/kungfu/contracts/kfd7-release-passport.json'),
      'utf8',
    ),
  );
  assert.equal(
    conformance.actionBindingVector.bindingRoot,
    reports[0].binding_root,
  );
  assert.equal(
    operationalSemantics.$schema,
    'kungfu.kfd7-embedder-operational-semantics/v1',
  );
  assert.equal(
    operationalSemantics.timeout.statusCode.disposition,
    'reserved-in-abi-v1',
  );
  assert.equal(operationalSemantics.recovery.discardableUnit, 'worker-process');
  assert.deepEqual(releasePassport.platformMatrix.required, [
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  assert.ok(
    fs.existsSync(
      path.join(prefix, 'share/kungfu/docs/libkungfu-abi-consumer.md'),
    ),
    'installed consumer guide is missing',
  );
  const installedLibrary =
    process.platform === 'win32'
      ? path.join(prefix, 'bin', 'kungfu.dll')
      : process.platform === 'darwin'
        ? path.join(prefix, 'lib', 'libkungfu.dylib')
        : path.join(prefix, 'lib', 'libkungfu.so');
  const installedBootstrapSymbols = assertInstalledBootstrapExports({
    policy: symbolPolicy,
    releasePassport,
    actualSymbols: publicSymbols(installedLibrary),
  });

  fs.cpSync(
    path.join(root, 'framework/core/examples/kfd7-yijinjing-source'),
    sourceStatic,
    { recursive: true },
  );
  fs.cpSync(
    path.join(root, 'framework/core/src/libyijinjing'),
    path.join(sourceStatic, 'libyijinjing'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(scratch, '.deps'), { recursive: true });
  fs.cpSync(
    path.join(root, 'framework/core/.deps/hana-1.80.0'),
    path.join(scratch, '.deps/hana-1.80.0'),
    { recursive: true },
  );
  run('cmake', [
    '-S',
    sourceStatic,
    '-B',
    sourceStaticBuild,
    `-DCMAKE_TOOLCHAIN_FILE=${path.join(buildDir, 'conan_toolchain.cmake')}`,
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
  run('cmake', ['--build', sourceStaticBuild, '--config', 'Release']);
  const sourceStaticExecutable =
    process.platform === 'win32'
      ? path.join(
          sourceStaticBuild,
          'Release',
          'kungfu_kfd7_yijinjing_source_consumer.exe',
        )
      : path.join(sourceStaticBuild, 'kungfu_kfd7_yijinjing_source_consumer');
  const sourceStaticReport = JSON.parse(
    run(sourceStaticExecutable, [path.join(scratch, 'source-static-journal')], {
      cwd: scratch,
      capture: true,
    }),
  );
  assert.equal(sourceStaticReport.fact_records, 2);
  assert.equal(sourceStaticReport.episode_records, 2);
  assert.equal(sourceStaticReport.language_hosts, 0);
  assert.equal(sourceStaticReport.verified, true);
  assert.equal(sourceStaticReport.recovery, 'resume-authoritative-append');
  assert.equal(
    sourceStaticReport.snapshot_schema,
    'kungfu.fact-ledger.snapshot/v1',
  );

  const sourceRevision = run('git', ['rev-parse', 'HEAD'], { capture: true });
  const report = {
    schema: 'kungfu.kfd7-installed-consumer-qualification/v1',
    status: 'passed',
    sourceRevision,
    platform: `${process.platform}-${process.arch}`,
    coordinate:
      'find_package(Kungfu 4 CONFIG REQUIRED); target_link_libraries(app PRIVATE Kungfu::kungfu)',
    repositoryPrivateIncludes: 0,
    languageHosts: 0,
    consumers: reports,
    sourceStaticConsumer: sourceStaticReport,
    installedContract:
      'share/kungfu/contracts/kfd7-library-boundary.contract.json',
    conformance: 'share/kungfu/contracts/kfd7-abi-conformance-v1.json',
    operationalSemantics:
      'share/kungfu/contracts/kfd7-embedder-operational-semantics-v1.json',
    releasePassport: 'share/kungfu/contracts/kfd7-release-passport.json',
    consumerGuide: 'share/kungfu/docs/libkungfu-abi-consumer.md',
    symbolPolicy: symbolPolicy.definedExports,
    bootstrapAdmission: installedBootstrapSymbols,
    scratchRetained: retain,
    scratch: retain ? scratch : null,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    const absoluteReport = path.resolve(root, reportPath);
    fs.mkdirSync(path.dirname(absoluteReport), { recursive: true });
    fs.writeFileSync(absoluteReport, serialized);
  }
  process.stdout.write(serialized);
} finally {
  if (!retain) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
