// SPDX-License-Identifier: Apache-2.0
//
// Happy-path capture fixture (gate G2, L0 slice): one command wraps an
// unmodified child process and produces a local run store — journal frames
// bracketing the run plus a self-describing trace bundle. Asserted by
// check_capture.py. Requires the core dev environment (built dist/kungfu).
//
// Usage: node tests/fixtures/rewind-demo-happy/run.mjs

import path from 'node:path';
import { locate, tmpDir, background, waitForFile, kfc, uvPython } from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('rewind-happy-');
const runId = `fixturehappy${Date.now()}`;

// Deterministic model upstream: the mock binds an ephemeral port and reports it
// through a file; the supervisor picks it up as the openai forward target. The
// mock runs detached (stdio ignored) so nothing holds a captured pipe open, and
// cleanup kills it — see _harness.background/onCleanup.
const portFile = path.join(home, 'mock-port');
background(PY, [path.join(fixtureDir, 'mock_model.py'), portFile]);
const port = waitForFile(portFile);
const openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

kfc(
  coreDir,
  home,
  ['trace', '--run-id', runId, '--', PY, path.join(fixtureDir, 'demo_agent.py')],
  { env: { OPENAI_BASE_URL: openaiBaseUrl } },
);

uvPython(coreDir, [
  path.join(fixtureDir, 'check_capture.py'),
  path.join(home, 'runtime'),
  runId,
]);
