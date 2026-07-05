// SPDX-License-Identifier: Apache-2.0
//
// Cross-runtime single-journal fixture (gate G7): a python agent calls a Node
// tool under one traced run; both runtimes' events must land in one journal
// with a shared run id, a causal edge across the boundary, and one timeline.
// Requires the core dev environment (built dist/kungfu) and node on PATH.
//
// Usage: node tests/fixtures/rewind-demo-cross-runtime/run.mjs

import path from 'node:path';
import { locate, tmpDir, background, waitForFile, kfc, uvPython, findBin, skip } from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);

if (!findBin(['node'])) skip('node not on PATH');

const home = tmpDir('rewind-cross-');
const runId = `fixturecross${Date.now()}`;

// The mock runs detached (stdio ignored) so nothing holds a captured pipe open,
// and cleanup kills it — see _harness.background/onCleanup.
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
