#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const measurement = fileURLToPath(
  new URL('./run-gate-measurement.mjs', import.meta.url),
);

function fail(message) {
  throw new Error(`[focused-gate-measurement] ${message}`);
}

const gateIds = String(process.env.KUNGFU_GATE_MEASUREMENT_FOCUS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (!gateIds.length) fail('KUNGFU_GATE_MEASUREMENT_FOCUS is required');
if (gateIds.some((gateId) => !/^[a-z][a-z0-9.-]*$/.test(gateId)))
  fail('focused Gate ids must use the canonical Gate id grammar');
if (gateIds.length !== new Set(gateIds).size)
  fail('focused Gate ids must be unique');

let capabilities;
try {
  capabilities = JSON.parse(
    process.env.KUNGFU_GATE_MEASUREMENT_CAPABILITIES || '[]',
  );
} catch {
  fail('KUNGFU_GATE_MEASUREMENT_CAPABILITIES must be JSON');
}
if (
  !Array.isArray(capabilities) ||
  capabilities.some(
    (capability) =>
      typeof capability !== 'string' || !/^[a-z][a-z0-9-]*$/.test(capability),
  )
)
  fail('focused Gate capabilities must be canonical string ids');

const receipt =
  process.env.KUNGFU_GATE_MEASUREMENT_RECEIPT ||
  path.join('.buildchain', 'gates', 'focused', 'receipt.json');
process.env.KUNGFU_GATE_MEASUREMENT_BOOTSTRAP = 'focused-diagnostic-v1';
const args = [
  measurement,
  'gate',
  'run',
  ...gateIds,
  ...[...new Set(capabilities)]
    .sort()
    .flatMap((item) => ['--capability', item]),
  '--receipt',
  receipt,
  '--overwrite',
  '--json',
];
const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
