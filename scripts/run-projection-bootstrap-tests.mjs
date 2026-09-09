// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const buildDir = path.join(process.cwd(), 'framework', 'core', 'build');
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'kungfu_projection_bootstrap_tests',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[projection-bootstrap-test] build: ${build.error.message}`);
  console.error(
    '[projection-bootstrap-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_projection_bootstrap_tests.exe'
    : 'kungfu_projection_bootstrap_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[projection-bootstrap-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/projection_bootstrap.h',
  'framework/core/src/libkungfu/src/runtime/projection_bootstrap.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/typed_state_projection.h',
  'framework/core/src/libkungfu/src/runtime/typed_state_projection.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/state_service.h',
  'framework/core/src/libkungfu/src/runtime/state_service.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/live/coordinator.h',
  'framework/core/src/libkungfu/src/runtime/live/coordinator.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/live/peer.h',
  'framework/core/src/libkungfu/src/runtime/live/peer.cpp',
  'framework/core/src/bindings/python/binding/py-runtime.cpp',
  'framework/core/src/bindings/node/binding/kungfu_node.cpp',
  'framework/core/src/python/kungfu/projection.py',
  'framework/core/src/python/kungfu/cli/commands/storage.py',
  'framework/core/lib/kungfu.js',
  'framework/core/lib/kungfu.d.ts',
  'framework/core/src/libkungfu/tests/projection_bootstrap_tests.cpp',
].map((source) => path.join(process.cwd(), source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[projection-bootstrap-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
  );
  process.exit(2);
}

console.log(`[projection-bootstrap-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[projection-bootstrap-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const restartRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-projection-process-restart-'),
);
try {
  for (const mode of [
    '--create-process-restart-fixture',
    '--verify-process-restart-fixture',
  ]) {
    const child = spawnSync(testBinary, [mode, restartRoot], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    if (child.error || child.status !== 0) {
      if (child.error)
        console.error(
          `[projection-bootstrap-test] ${mode}: ${child.error.message}`,
        );
      process.exit(child.status ?? 2);
    }
  }
  const bindingDir = [
    path.join(process.cwd(), 'framework', 'core', 'dist', 'kungfu'),
    path.join(buildDir, 'Release'),
    buildDir,
  ].find((candidate) =>
    fs.existsSync(path.join(candidate, 'kungfu_node.node')),
  );
  if (!bindingDir) {
    console.error('[projection-bootstrap-test] Node binding not found');
    process.exit(2);
  }
  const pythonEnvironment =
    process.env.UV_PROJECT_ENVIRONMENT ||
    path.join(process.cwd(), 'framework', 'core', '.venv');
  const python =
    process.platform === 'win32'
      ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
      : path.join(pythonEnvironment, 'bin', 'python');
  const pythonResult = spawnSync(
    python,
    [
      '-c',
      [
        'import json',
        'from click.testing import CliRunner',
        'from kungfu import projection',
        'from kungfu.cli.commands import __registry__, kfc',
        "root=__import__('os').environ['KUNGFU_PROJECTION_TEST_ROOT']",
        "s=projection.candidate_status(data_root=root, stream_id=71, container_epoch=5, writer_resource_id='projection-restart-writer', qualification_profile='candidate/test-local-filesystem/v1')",
        "assert s['schema']=='kungfu.projection-candidate-status/v1' and s['authority']=='libkungfu'",
        "assert s['outcome']=='ready' and s['hydrated'] is True and s['production_eligible'] is False",
        "r=CliRunner().invoke(kfc, ['--home', root, 'storage', 'projection-candidate-status', '--data-root', root, '--stream-id', '71', '--container-epoch', '5', '--writer-resource-id', 'projection-restart-writer', '--qualification-profile', 'candidate/test-local-filesystem/v1'])",
        'assert r.exit_code == 0, r.output',
        "assert json.loads(r.output)['outcome']=='ready'",
      ].join('; '),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KUNGFU_PROJECTION_TEST_ROOT: restartRoot,
        PYTHONPATH: [
          bindingDir,
          path.join(process.cwd(), 'framework', 'core', 'src', 'python'),
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
      },
      stdio: 'inherit',
    },
  );
  if (pythonResult.error || pythonResult.status !== 0) {
    if (pythonResult.error)
      console.error(
        `[projection-bootstrap-test] Python/CLI: ${pythonResult.error.message}`,
      );
    process.exit(pythonResult.status ?? 2);
  }

  process.env.KUNGFU_DIR = bindingDir;
  const require = createRequire(import.meta.url);
  const kungfu = require('@kungfu-tech/core/kungfu')();
  const nodeStatus = kungfu.projectionCandidateStatusTyped({
    data_root: restartRoot,
    stream_id: 71n,
    container_epoch: 5n,
    writer_resource_id: 'projection-restart-writer',
    qualification_profile: 'candidate/test-local-filesystem/v1',
  });
  if (
    nodeStatus.schema !== 'kungfu.projection-candidate-status/v1' ||
    nodeStatus.authority !== 'libkungfu' ||
    nodeStatus.outcome !== 'ready' ||
    nodeStatus.hydrated !== true ||
    nodeStatus.production_eligible !== false
  ) {
    console.error(
      '[projection-bootstrap-test] Node status diverged from native authority',
    );
    process.exit(1);
  }
  console.log(
    '[projection-bootstrap-test] Python/Node/CLI status parity passed',
  );
  console.log('[projection-bootstrap-test] cross-process restart passed');
} finally {
  fs.rmSync(restartRoot, { recursive: true, force: true });
}

const coordinatorSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'framework/core/src/libkungfu/src/runtime/live/coordinator.cpp',
  ),
  'utf8',
);
for (const requiredSeam of [
  'bootstrap_projection_candidate',
  'if (!projection_declaration.candidate)',
  'state_service_.restore(peer_location, peer_cmd_writer)',
]) {
  if (!coordinatorSource.includes(requiredSeam)) {
    console.error(
      `[projection-bootstrap-test] live candidate/rollback seam missing: ${requiredSeam}`,
    );
    process.exit(1);
  }
}

console.log(
  '[projection-bootstrap-test] candidate snapshot/replay contracts passed',
);
