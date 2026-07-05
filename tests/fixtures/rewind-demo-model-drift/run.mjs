// SPDX-License-Identifier: Apache-2.0
//
// Model-drift fixture (gate G6/D3): the model selects a nonexistent tool;
// the record must show the drift point (the model node output) and its
// consequence (the routing step failing on that exact name).
//
// Usage: node tests/fixtures/rewind-demo-model-drift/run.mjs

import path from 'node:path';
import {
  locate,
  tmpDir,
  background,
  waitForFile,
  kfc,
  uvPython,
  assertContains,
  fail,
} from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('rewind-drift-');
const runId = `fixturedrift${Date.now()}`;

// stdio-detached, killed on cleanup — see rewind-demo-happy/run.mjs for why
const portFile = path.join(home, 'mock-port');
background(PY, [path.join(fixtureDir, 'mock_model.py'), portFile]);
const port = waitForFile(portFile);
const openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

// the traced run is EXPECTED to fail with exit 1; anything else is a fixture bug
const traced = kfc(
  coreDir,
  home,
  ['trace', '--run-id', runId, '--', PY, path.join(fixtureDir, 'demo_agent.py')],
  { env: { OPENAI_BASE_URL: openaiBaseUrl }, allowFail: true },
);
if (traced.status !== 1) {
  fail(`expected traced run to exit 1, got ${traced.status}`);
}

const tree = kfc(coreDir, home, ['rewind', 'show', '--run', runId]);
process.stdout.write(`${tree.stdout}\n`);
assertContains(tree, '✗', 'failed node not marked in tree');
console.log('ok  tree marks the failure');

uvPython(coreDir, [
  path.join(fixtureDir, 'check_capture.py'),
  path.join(home, 'runtime'),
  runId,
]);
