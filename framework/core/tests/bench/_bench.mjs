// SPDX-License-Identifier: Apache-2.0
//
// Shared harness for the dispatch-latency bench drivers (dispatch_bench.mjs and
// dispatch_bench_watcher.mjs, replacing the two run.sh forms), so the ADR-0005
// evidence harness runs under plain node on every platform pnpm runs on — no
// bash. Pure Node: child_process, fs, os. Both drivers start a coordinator with the
// KF_DISPATCH_PROBE instrument enabled, drive a typed-frame load through a
// registered peer, then print the probe reports collected from the logs.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// short home: nanomsg ipc sockets live under it and macOS caps sun_path at 104,
// so the default deep /var/folders $TMPDIR overflows it. /tmp keeps it short on
// Unix; Windows named-pipe ipc has no such limit, so os.tmpdir() is fine.
export function benchHome() {
  const root = isWin ? os.tmpdir() : '/tmp';
  return fs.mkdtempSync(path.join(root, 'kfb.'));
}

// dev-python import of pykungfu / dev-node load of the binding: give the
// dynamic loader the built dist/kungfu as a fallback search dir (same as the
// capture fixtures). Also stamps KF_DISPATCH_PROBE=1 so reactor.cpp emits the
// per-frame report.
export function probeEnv(coreDir, extra = {}) {
  const dist = path.join(coreDir, 'dist', 'kungfu');
  const env = { ...process.env, KF_DISPATCH_PROBE: '1', ...extra };
  if (isMac) {
    env.DYLD_FALLBACK_LIBRARY_PATH = prepend(
      dist,
      env.DYLD_FALLBACK_LIBRARY_PATH,
    );
  } else if (isWin) {
    env.PATH = prepend(dist, env.PATH); // dll search order
  } else {
    env.LD_LIBRARY_PATH = prepend(dist, env.LD_LIBRARY_PATH);
  }
  return env;
}

function prepend(dir, existing) {
  return existing ? `${dir}${path.delimiter}${existing}` : dir;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start the coordinator. Same invocation shape the app supervisor uses (processUtils
// buildKungfuArgs); stdout+stderr land in <home>/coordinator.out.
export function startCoordinator(coreDir, home, env) {
  const out = fs.openSync(path.join(home, 'coordinator.out'), 'w');
  return track(
    spawn(
      'uv',
      [
        'run',
        '--frozen',
        'python',
        '.devtools/kungfu_cli.py',
        '-H',
        home,
        'runtime',
        'run',
        '--home',
        home,
        '--runtime-dir',
        path.join(home, 'runtime'),
        '--low-latency',
      ],
      { cwd: coreDir, env, stdio: ['ignore', out, out] },
    ),
  );
}

// Drive the load synchronously (mirrors the blocking foreground call in run.sh):
// register a real peer and write `count` typed schema frames in batches
// of 64. loadType selects the frame kind ("quote" typed frames by default).
export function runLoad(benchDir, home, count, loadType, env) {
  return spawnSync(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      path.join(benchDir, 'dispatch_load.py'),
      home,
      String(count),
      '64',
      loadType,
    ],
    { stdio: 'inherit', env },
  );
}

// grep -h "dispatch probe" across the given files; returns the matched lines.
export function collectProbeReports(files) {
  const lines = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // file may not exist (e.g. no runtime logs yet)
    }
    for (const line of text.split('\n')) {
      if (line.includes('dispatch probe')) lines.push(line);
    }
  }
  return lines;
}

// Recursively collect *.log files under dir (replaces `find dir -name '*.log'`).
export function findLogs(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findLogs(p));
    else if (e.name.endsWith('.log')) out.push(p);
  }
  return out;
}

// --- child liveness / lifecycle (replaces `kill -0` + the trap EXIT cleanup) --

// Track a child for liveness (alive/waitExit) and kill it on our own exit —
// the equivalent of the run.sh `trap cleanup EXIT`. Returns the child.
export function killOnExit(child) {
  child.once('exit', () => {
    child.__exited = true;
  });
  killers.push(child);
  return child;
}

const track = killOnExit;

export function alive(child) {
  return !child.__exited;
}

// Resolve once the child has exited, or after ms (whichever first).
export function waitExit(child, ms) {
  if (child.__exited) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const killers = [];
function killAll() {
  for (const c of killers) {
    try {
      c.kill();
    } catch {
      /* best-effort */
    }
  }
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAll();
    process.exit(1);
  });
}
