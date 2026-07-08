// SPDX-License-Identifier: Apache-2.0
//
// Event-dispatch latency baseline, master form (ADR-0005 evidence).
//
// Starts a master with the KF_DISPATCH_PROBE instrument enabled, drives it
// with an open-layer event burst from a registered apprentice (dispatch_load.py),
// then prints the probe reports collected on the master side. Requires the core
// dev environment (built dist/kungfu) and the repo-pinned node (run under
// ./kungfu-code or fnm so process.execPath matches the built binding).
//
// Usage: node tests/bench/dispatch_bench.mjs [event-count] [load-type]
//
//   KF_BYPASS_CACHED=1 node tests/bench/dispatch_bench.mjs   # rx-isolated run
//   node tests/bench/dispatch_bench.mjs                      # storage-on run
//   node tests/bench/dispatch_bench.mjs 200000 1000          # action-envelope control run

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alive,
  benchHome,
  collectProbeReports,
  findLogs,
  probeEnv,
  runLoad,
  sleep,
  startMaster,
  waitExit,
} from './_bench.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(benchDir, '..', '..'); // framework/core

const count = Number.parseInt(process.argv[2] || '200000', 10);
// "quote" (typed schema frames) by default: both master and the node watcher
// pre-filter open-layer events in is_reactable before rx, so only typed frames
// actually traverse the filter chains being measured
const loadType = process.argv[3] || 'quote';

const home = benchHome();
console.log(
  `bench home: ${home} (KF_BYPASS_CACHED=${process.env.KF_BYPASS_CACHED ?? 'unset'})`,
);

const env = probeEnv(coreDir);
const master = startMaster(coreDir, home, env);

// let master bind sockets and settle
await sleep(3000);
if (!alive(master)) {
  console.error('master failed to start:');
  process.stderr.write(fs.readFileSync(path.join(home, 'master.out'), 'utf8'));
  process.exit(1);
}

runLoad(benchDir, home, count, loadType, env);

// let at least one 5s probe report tick fire after the burst settles
await sleep(6000);
master.kill();
await waitExit(master, 5000);

console.log('--- dispatch probe reports (master) ---');
const reports = collectProbeReports([
  path.join(home, 'master.out'),
  ...findLogs(path.join(home, 'runtime')),
]);
if (reports.length === 0) {
  console.error(
    `no probe output found — check ${path.join(home, 'master.out')}`,
  );
  process.exit(1);
}
for (const line of reports) console.log(line);
console.log(`bench home kept for inspection: ${home}`);
