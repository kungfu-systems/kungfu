// SPDX-License-Identifier: Apache-2.0
//
// Event-dispatch latency baseline, node watcher form (ADR-0005 evidence).
//
// Constructs the real node Watcher against a running master's KF_HOME and
// starts its uv pump (hero::step through hero::drain), so the
// KF_DISPATCH_PROBE instrument reports the watcher-side per-frame rx
// traversal cost into the watcher's log. Run under plain node from
// framework/core; the load is driven separately by dispatch_load.py
// (use the "quote" type — open-layer events are pre-filtered by the
// watcher's is_reactable and never reach its rx chains).
//
// Usage: node tests/bench/dispatch_watcher_bench.js <kf-home> <seconds>

const path = require('path');

const home = process.argv[2];
const seconds = parseInt(process.argv[3] || '30', 10);
if (!home) {
  console.error('usage: dispatch_watcher_bench.js <kf-home> <seconds>');
  process.exit(2);
}

const coreDir = path.resolve(__dirname, '..', '..');
// require the binding artifact directly: the lib/kungfu.js loader resolves
// the '@kungfu-tech/core' package name, which is not self-linked inside this
// package's own node_modules
const binding = require(path.join(coreDir, 'dist', 'kfc', 'kungfu_node.node'));

const runtimeDir = path.join(home, 'runtime');
// bypassRestore=true: no config-db state to restore in a bench home;
// sleep-after-step=2ms keeps the pump hot without busy-burning a core.
const watcher = new binding.Watcher(
  runtimeDir,
  'dispatch_bench',
  true, // bypassRestore
  false, // bypassAccounting
  false, // bypassTradingData
  true, // refreshTradingDataBeforeSync
  false, // bypassRefreshBook
  2, // millisecondsSleepAfterStep
);

console.log('watcher created, starting uv pump for', seconds, 'seconds');
watcher.start();

const sync = setInterval(() => watcher.sync(), 1000);

setTimeout(() => {
  clearInterval(sync);
  console.log('watcher bench window done, quitting');
  watcher.quit();
  // give the uv worker a moment to unwind before process exit
  setTimeout(() => process.exit(0), 2000);
}, seconds * 1000);
