// SPDX-License-Identifier: Apache-2.0
//
// Event-dispatch latency baseline, node watcher form (KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412 evidence).
//
// Starts a coordinator, attaches the real node Watcher under plain node
// (dispatch_watcher_bench.js), drives typed Quote load through a registered
// peer, then prints the probe reports collected on the watcher side.
// Requires the core dev environment (built dist/kungfu) and the repo-pinned
// node — run under ./shifu or fnm so process.execPath (used to spawn the
// watcher) matches the ABI of the built kungfu_node.node binding.
//
// Usage: node tests/bench/dispatch_bench_watcher.mjs [event-count]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alive,
  benchHome,
  collectProbeReports,
  findLogs,
  killOnExit,
  probeEnv,
  runLoad,
  sleep,
  startCoordinator,
  waitExit,
} from './_bench.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(benchDir, '..', '..'); // framework/core
const repoDir = path.resolve(coreDir, '..', '..'); // repo root

const count = Number.parseInt(process.argv[2] || '200000', 10);

const home = benchHome();
console.log(`bench home: ${home}`);

const env = probeEnv(coreDir);
const coordinator = startCoordinator(coreDir, home, env);

await sleep(3000);
if (!alive(coordinator)) {
  console.error('coordinator failed to start:');
  process.stderr.write(
    fs.readFileSync(path.join(home, 'coordinator.out'), 'utf8'),
  );
  process.exit(1);
}

// watcher window: register grace + load + probe report ticks. Spawn with the
// same node running this driver (process.execPath) so the native binding loads
// under the pinned ABI — the run.sh form used `fnm exec --using-file` to reach
// that node; here the driver is already node, so its own binary is correct.
const watcherOut = fs.openSync(path.join(home, 'watcher.out'), 'w');
const watcher = killOnExit(
  spawn(
    process.execPath,
    [path.join(benchDir, 'dispatch_watcher_bench.js'), home, '40'],
    { cwd: repoDir, env, stdio: ['ignore', watcherOut, watcherOut] },
  ),
);

await sleep(5000);
if (!alive(watcher)) {
  console.error('watcher failed to start:');
  process.stderr.write(fs.readFileSync(path.join(home, 'watcher.out'), 'utf8'));
  process.exit(1);
}

runLoad(benchDir, home, count, 'quote', env);

// the watcher self-exits after its 40s window (+ unwind); wait it out
await waitExit(watcher, 90000);

console.log('--- dispatch probe reports (watcher) ---');
const reports = collectProbeReports([
  path.join(home, 'watcher.out'),
  ...findLogs(path.join(home, 'runtime', 'log', 'system', 'node')),
]);
if (reports.length === 0) {
  console.error(
    `no watcher probe output found — check ${path.join(home, 'watcher.out')}`,
  );
  process.exit(1);
}
for (const line of reports) console.log(line);
console.log(`bench home kept for inspection: ${home}`);
