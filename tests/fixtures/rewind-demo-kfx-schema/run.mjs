// SPDX-License-Identifier: Apache-2.0
//
// kfx action-envelope fixture (S5): a kfx compiles its own `.fbs` at runtime,
// registers the schema into the traced run, and emits an event of its own
// action_type. The event lands in the journal, the schema binds into the bundle,
// and it decodes by reflection with no generated accessor. Asserted by
// check_capture.py.
// Requires the core dev environment (built dist/kungfu, whose python has flatbuffers).
//
// Usage: node tests/fixtures/rewind-demo-kfx-schema/run.mjs

import path from 'node:path';
import { locate, tmpDir, kfc, uvPython } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('rewind-kfx-');
const runId = `fixturekfx${Date.now()}`;

// the kfx child is the core's own interpreter (has flatbuffers); it reaches the
// kungfu package + binding itself, and the supervisor injects the capture hook.
// dyld/ld/PATH fallback so both the supervisor and the kfx child can import
// pykungfu (compile_schema) is provided by the harness runtimeEnv (folded into kfc).
const venvPython =
  process.platform === 'win32'
    ? path.join(coreDir, '.venv', 'Scripts', 'python.exe')
    : path.join(coreDir, '.venv', 'bin', 'python');

kfc(coreDir, home, [
  'trace',
  '--run-id',
  runId,
  '--',
  venvPython,
  path.join(fixtureDir, 'kfx_program.py'),
]);

uvPython(coreDir, [
  path.join(fixtureDir, 'check_capture.py'),
  path.join(home, 'runtime'),
  runId,
]);
