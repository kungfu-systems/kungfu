// SPDX-License-Identifier: Apache-2.0
//
// Forensic replay fixture (gate G-Moat, machine half): record a cross-runtime
// run, then prove the record self-describes —
//   show    the causal tree reconstructs from the journal alone;
//   verify  the native decode and the bundle's reflection decode (no generated
//           event code) agree fact-for-fact over every frame;
//   tamper  a corrupted schema blob must make verify FAIL (falsification —
//           the check has teeth, it is not vacuously green).
//
// Usage: node tests/fixtures/rewind-demo-forensic-replay/run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { locate, tmpDir, background, waitForFile, kfc, assertContains, findBin, skip, fail } from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);

if (!findBin(['node'])) skip('node not on PATH');

const home = tmpDir('rewind-replay-');
const runId = `fixturereplay${Date.now()}`;

// The mock runs detached (stdio ignored) so nothing holds a captured pipe open,
// and cleanup kills it — see _harness.background/onCleanup.
const portFile = path.join(home, 'mock-port');
background(PY, [path.join(fixtureDir, 'mock_model.py'), portFile]);
const port = waitForFile(portFile);
const openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

const k = (args, opts = {}) =>
  kfc(coreDir, home, args, { env: { OPENAI_BASE_URL: openaiBaseUrl }, ...opts });

k(['trace', '--run-id', runId, '--', PY, path.join(fixtureDir, 'demo_agent.py')]);

console.log('--- rewind show ---');
const show = k(['rewind', 'show', '--run', runId]);
process.stdout.write(show.stdout);
assertContains(show, 'tool delegate', 'python tool missing from tree');
assertContains(show, 'tool node-lookup', 'node tool missing from tree');
assertContains(show, 'model openai', 'model span missing from tree');
// the node tool must render nested under the python delegate (cross-runtime edge).
// Mirrors `grep -A1 "tool delegate" | grep -q "  - tool node-lookup"`: for each
// delegate line, the line itself plus the following line form the -A1 window;
// node-lookup must appear nested in one of those windows.
const treeLines = (show.stdout || '').split('\n');
let nestedOk = false;
for (let i = 0; i < treeLines.length; i++) {
  if (!treeLines[i].includes('tool delegate')) continue;
  const window = [treeLines[i], treeLines[i + 1] ?? ''];
  if (window.some((l) => l.includes('  - tool node-lookup'))) {
    nestedOk = true;
    break;
  }
}
if (!nestedOk) fail('node tool not nested under python delegate');
console.log('ok  causal tree reconstructs with the cross-runtime edge');

console.log('--- rewind verify ---');
const verify = k(['rewind', 'verify', '--run', runId]);
assertContains(verify, 'verify passed', 'two decode paths disagree');
console.log('ok  native and reflection decodes agree');

console.log('--- tamper falsification ---');
const bundle = path.join(home, 'runtime', 'rewind', runId, 'bundle');
const tampered = path.join(home, 'tampered-bundle');
fs.cpSync(bundle, tampered, { recursive: true });
const schemasDir = path.join(tampered, 'schemas');
const blob = fs.readdirSync(schemasDir).sort()[0];
// corrupt one byte at offset 64 (mirrors `printf 'x' | dd seek=64 conv=notrunc`)
const blobPath = path.join(schemasDir, blob);
const fd = fs.openSync(blobPath, 'r+');
fs.writeSync(fd, Buffer.from('x'), 0, 1, 64);
fs.closeSync(fd);
const tamperVerify = k(['rewind', 'verify', '--run', runId, '--bundle', tampered], {
  allowFail: true,
});
if (tamperVerify.status === 0) {
  fail('tampered bundle passed verify (check is vacuous)');
}
console.log('ok  tampered bundle rejected');

console.log('forensic replay check passed');
