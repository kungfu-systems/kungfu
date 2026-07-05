// SPDX-License-Identifier: Apache-2.0
//
// Tool-failure fixture (gate G6/D2): the traced agent fails on a broken tool;
// the record must make the failure diagnosable — errored ToolResult with the
// real detail, failed run status, ✗ in the rendered tree.
//
// Usage: node tests/fixtures/rewind-demo-tool-failure/run.mjs

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
const home = tmpDir('rewind-toolfail-');
const runId = `fixturetoolfail${Date.now()}`;

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
