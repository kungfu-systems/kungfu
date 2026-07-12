// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const executable =
  process.platform === 'win32'
    ? 'kungfu_durability_contract_tests.exe'
    : 'kungfu_durability_contract_tests';
const buildDir = path.join(
  process.cwd(),
  'framework',
  'core',
  'build',
  'Release',
);
const candidates = [
  path.join(buildDir, executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));

if (!testBinary) {
  console.error(
    '[durability-contract-test] binary not found; run ./shifu build:core first',
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

const python =
  process.platform === 'win32'
    ? path.join(
        process.cwd(),
        'framework',
        'core',
        '.venv',
        'Scripts',
        'python.exe',
      )
    : path.join(process.cwd(), 'framework', 'core', '.venv', 'bin', 'python');
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
    ].join('; '),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [buildDir, process.env.PYTHONPATH]
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
process.env.KUNGFU_DIR = buildDir;
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
