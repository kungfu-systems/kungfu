// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const executable =
  process.platform === 'win32'
    ? 'kungfu_durability_contract_tests.exe'
    : 'kungfu_durability_contract_tests';
const coreDir = path.join(process.cwd(), 'framework', 'core');
const buildRoot = path.join(coreDir, 'build');
const releaseBuildDir = path.join(buildRoot, 'Release');
const candidates = [
  path.join(releaseBuildDir, executable),
  path.join(buildRoot, executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
const bindingDir = [
  path.join(coreDir, 'dist', 'kungfu'),
  releaseBuildDir,
  buildRoot,
].find((candidate) => fs.existsSync(path.join(candidate, 'kungfu_node.node')));
const fixtureExecutable =
  process.platform === 'win32'
    ? 'kungfu_durability_powercut_fixture.exe'
    : 'kungfu_durability_powercut_fixture';
const fixtureBinary = [
  path.join(releaseBuildDir, fixtureExecutable),
  path.join(buildRoot, fixtureExecutable),
].find((candidate) => fs.existsSync(candidate));

if (!testBinary || !fixtureBinary || !bindingDir) {
  console.error(
    '[durability-contract-test] binary, fixture, or Node binding not found; run ./shifu build:core first',
  );
  process.exit(2);
}

console.log(`[durability-contract-test] running ${testBinary}`);
const nativeResult = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (nativeResult.error) {
  console.error(
    `[durability-contract-test] failed to start: ${nativeResult.error.message}`,
  );
  process.exit(1);
}
if (nativeResult.status !== 0) process.exit(nativeResult.status ?? 1);

const reconciliationRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kf-durability-reconcile-'),
);
fs.writeFileSync(
  path.join(reconciliationRoot, '.kungfu-disposable-powercut-fixture'),
  'kungfu.durability.disposable-root/v1\n',
);
console.log('[durability-contract-test] producing checkpoint-covered receipt');
const fixtureResult = spawnSync(
  fixtureBinary,
  ['write', reconciliationRoot, 'durable_sync', 'none'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUNGFU_DURABILITY_QUALIFICATION: 'disposable-powercut',
    },
    stdio: 'inherit',
  },
);
if (fixtureResult.error || fixtureResult.status !== 0) {
  if (fixtureResult.error)
    console.error(
      `[durability-contract-test] receipt fixture failed to start: ${fixtureResult.error.message}`,
    );
  process.exit(fixtureResult.status ?? 1);
}

const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT ||
  path.join(process.cwd(), 'framework', 'core', '.venv');
const python =
  process.platform === 'win32'
    ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
    : path.join(pythonEnvironment, 'bin', 'python');
console.log('[durability-contract-test] checking Python typed surface');
const pythonResult = spawnSync(
  python,
  [
    '-c',
    [
      'import pykungfu',
      "r = pykungfu.runtime.durability_visible_receipt_typed(1, 2, 3, 4, 5, 'durable_sync', 6)",
      "assert r['status'] == 'failed'",
      "assert r['error'] == 'unsupported_profile'",
      "assert r['achieved_profile'] == 'visible'",
      "assert r['durable_watermark'] is None",
      'c = pykungfu.runtime.durability_capability_typed()',
      "assert c['schema'] == 'kungfu.durability.capability/v1'",
      "assert c['authority'] == 'libkungfu'",
      "assert c['support_level'] == 'production-candidate'",
      "assert c['production_eligible'] is False",
      "assert c['restore']['off_host'] is True",
      "assert c['admission']['current_hardware_candidate_complete'] is True",
      "assert c['admission']['candidate_profile_default_enabled'] is False",
      "assert c['admission']['physical_power_loss_qualified'] is False",
      'import json, tempfile',
      'from click.testing import CliRunner',
      'from kungfu import durability',
      'from kungfu.cli.commands import __registry__',
      'from kungfu.cli.commands import kfc',
      "d = tempfile.mkdtemp(prefix='kf-durability-capability-')",
      "result = CliRunner().invoke(kfc, ['--home', d, 'agent', 'capabilities', '--json'])",
      'assert result.exit_code == 0, result.output',
      "assert json.loads(result.output)['durability'] == durability.capabilities()",
      "root = __import__('os').environ['KUNGFU_DURABILITY_TEST_ROOT']",
      "reconciled = durability.reconcile(data_root=root, request_id=10001, stream_id=7, container_epoch=11, sequence=1, frame_uid=1001, requested_profile='durable_sync', writer_resource_id='00000001.00000002', qualification_profile='test/disposable-powercut/v1')",
      "assert reconciled['schema'] == 'kungfu.durability.reconciliation/v1'",
      "assert reconciled['state'] == 'reconciled' and reconciled['recovered'] is True",
      "assert reconciled['receipt']['request_id'] == 10001",
      "cli = CliRunner().invoke(kfc, ['--home', tempfile.mkdtemp(prefix='kf-durability-cli-'), 'storage', 'durability-reconcile', '--data-root', root, '--request-id', '10001', '--stream-id', '7', '--container-epoch', '11', '--sequence', '1', '--frame-uid', '1001', '--requested-profile', 'durable_sync', '--writer-resource-id', '00000001.00000002', '--qualification-profile', 'test/disposable-powercut/v1'])",
      'assert cli.exit_code == 0, cli.output',
      "assert json.loads(cli.output)['state'] == 'reconciled'",
    ].join('; '),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUNGFU_DURABILITY_TEST_ROOT: reconciliationRoot,
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
      `[durability-contract-test] Python check failed to start: ${pythonResult.error.message}`,
    );
  process.exit(pythonResult.status ?? 1);
}

console.log('[durability-contract-test] checking Node typed surface');
process.env.KUNGFU_DIR = bindingDir;
const require = createRequire(import.meta.url);
const kungfu = require('../framework/core/lib/kungfu.js')();
const receipt = kungfu.durabilityVisibleReceiptTyped({
  request_id: 9007199254740993n,
  stream_id: 9007199254740995n,
  container_epoch: 9007199254740997n,
  sequence: 9007199254740999n,
  frame_uid: 9007199254741001n,
  requested_profile: 'durable_group',
  completed_at: 9007199254741003n,
});
if (
  receipt.request_id !== 9007199254740993n ||
  receipt.position.sequence !== 9007199254740999n ||
  receipt.completed_at !== 9007199254741003n ||
  receipt.status !== 'failed' ||
  receipt.error !== 'unsupported_profile' ||
  receipt.achieved_profile !== 'visible' ||
  receipt.durable_watermark !== null
) {
  console.error(
    '[durability-contract-test] Node surface overstated durability',
  );
  process.exit(1);
}

const capability = kungfu.durabilityCapabilityTyped();
if (
  capability.schema !== 'kungfu.durability.capability/v1' ||
  capability.authority !== 'libkungfu' ||
  capability.support_level !== 'production-candidate' ||
  capability.production_eligible !== false ||
  capability.restore.off_host !== true ||
  capability.admission.current_hardware_candidate_complete !== true ||
  capability.admission.candidate_profile_default_enabled !== false ||
  capability.admission.physical_power_loss_qualified !== false ||
  capability.profiles.some(
    (profile) =>
      profile.name !== 'visible' && profile.production_eligible !== false,
  )
) {
  console.error(
    '[durability-contract-test] Node capability surface overstated durability',
  );
  process.exit(1);
}

const reconciled = kungfu.durabilityReconcileTyped({
  data_root: reconciliationRoot,
  request_id: 10001n,
  stream_id: 7n,
  container_epoch: 11n,
  sequence: 1n,
  frame_uid: 1001n,
  requested_profile: 'durable_sync',
  writer_resource_id: '00000001.00000002',
  qualification_profile: 'test/disposable-powercut/v1',
});
if (
  reconciled.schema !== 'kungfu.durability.reconciliation/v1' ||
  reconciled.state !== 'reconciled' ||
  reconciled.recovered !== true ||
  reconciled.receipt?.request_id !== 10001n
) {
  console.error(
    '[durability-contract-test] Node reconciliation diverged from native authority',
  );
  process.exit(1);
}
