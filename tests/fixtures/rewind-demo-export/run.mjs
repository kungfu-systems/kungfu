// SPDX-License-Identifier: Apache-2.0
//
// Export/open fixture (gate G8): a recorded run packs into one portable file
// that re-opens ANYWHERE — proven the hard way: the original home is deleted
// before the export is opened in a fresh location, and the opened copy must
// still verify (two-path decode) and render the full causal tree. Offline,
// no services.
//
// Usage: node tests/fixtures/rewind-demo-export/run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { locate, tmpDir, background, waitForFile, kfc, assertContains, fail } from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);

const home = tmpDir('rewind-export-home-');
const opened = tmpDir('rewind-export-opened-');
const runId = `fixtureexport${Date.now()}`;

// stdio-detached, killed on cleanup — see rewind-demo-happy/run.mjs for why
const portFile = path.join(home, 'mock-port');
background(PY, [path.join(fixtureDir, 'mock_model.py'), portFile]);
const port = waitForFile(portFile);
const openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

const k = (args) => kfc(coreDir, home, args, { env: { OPENAI_BASE_URL: openaiBaseUrl } });
const kOpened = (args) => kfc(coreDir, opened, args, { env: { OPENAI_BASE_URL: openaiBaseUrl } });

k(['trace', '--run-id', runId, '--', PY, path.join(fixtureDir, 'demo_agent.py')]);

const archive = path.join(opened, `${runId}.rewind.zip`);
k(['rewind', 'export', '--run', runId, '-o', archive]);
if (!(fs.existsSync(archive) && fs.statSync(archive).size > 0)) {
  fail('export produced no archive');
}
console.log(`ok  export produced ${fs.statSync(archive).size} bytes`);

// the hard part: the original home disappears entirely
fs.rmSync(path.join(home, 'runtime'), { recursive: true, force: true });
console.log('ok  original home deleted');

const out = kOpened(['rewind', 'open', archive, '--dir', path.join(opened, 'reopened')]);
process.stdout.write(out.stdout);
assertContains(out, 'frames verified', 'opened export did not verify');
assertContains(out, 'tool lookup', 'tree missing tool node');
assertContains(out, 'model openai/demo-model', 'tree missing model node');
assertContains(out, '(retry #2)', 'tree missing retry annotation');
console.log('ok  opened export verifies and renders the full tree');

console.log('export/open check passed');
