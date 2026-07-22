// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const EXECUTABLE = path.join(
  ROOT,
  'framework',
  'core',
  'dist',
  'kungfu',
  process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
);

function invoke(home, configHome, args) {
  const started = process.hrtime.bigint();
  const result = spawnSync(EXECUTABLE, ['-H', home, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      KF_CONFIG_HOME: configHome,
      KF_RUNTIME_DIR: path.join(home, 'runtime'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const durationUs = Number((process.hrtime.bigint() - started) / 1000n);
  if (result.error || result.status !== 0) {
    throw new Error(
      `product command failed (${args.join(' ')}): ${result.error?.message || result.stderr || result.stdout}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `product command returned non-JSON (${args.join(' ')}): ${result.stdout}`,
    );
  }
  return { payload, durationUs };
}

function running(payload) {
  return (
    payload?.supervisor?.running === true &&
    payload?.coordinator?.running === true
  );
}

function waitForRunning(home, configHome) {
  let latest;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = invoke(home, configHome, ['runtime', 'status', '--json']);
    if (running(latest.payload)) return latest;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(
    `product runtime did not become running: ${JSON.stringify(latest?.payload)}`,
  );
}

function main() {
  if (!fs.existsSync(EXECUTABLE)) {
    throw new Error(`frozen product executable is missing: ${EXECUTABLE}`);
  }
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-runtime-product-smoke-'),
  );
  const home = path.join(temporary, 'home');
  const configHome = path.join(temporary, 'config');
  let stop = null;
  try {
    const daemonless = invoke(home, configHome, [
      'runtime',
      'plan',
      'episode.inspect',
      '--json',
    ]);
    if (daemonless.payload.requirement?.operationClass !== 'storage-only') {
      throw new Error('product storage plan did not remain daemonless');
    }
    const before = invoke(home, configHome, ['runtime', 'status', '--json']);
    if (
      before.payload.product?.availability !== 'available' ||
      before.payload.product?.liveState !== 'inactive' ||
      before.payload.supervisor?.running !== false
    ) {
      throw new Error('daemonless product status invented live readiness');
    }

    const cold = invoke(home, configHome, ['runtime', 'ensure', '--json']);
    const coldStatus = waitForRunning(home, configHome);
    const warm = invoke(home, configHome, ['runtime', 'ensure', '--json']);
    if (warm.payload.changed !== false) {
      throw new Error('warm product ensure did not reuse the resident runtime');
    }
    const restart = invoke(home, configHome, ['runtime', 'restart', '--json']);
    const restartStatus = waitForRunning(home, configHome);
    stop = invoke(home, configHome, ['runtime', 'stop', '--json']);
    const stopped = invoke(home, configHome, ['runtime', 'status', '--json']);
    if (
      stopped.payload.supervisor?.running !== false ||
      stopped.payload.coordinator?.running !== false
    ) {
      throw new Error('product stop left the temporary runtime running');
    }
    console.log(
      JSON.stringify(
        {
          schema: 'kungfu.runtime-activation.product-smoke/v1',
          platform: { os: process.platform, arch: process.arch },
          envelope: 'temporary-product-workspace-process-live-v1',
          outcomes: {
            daemonlessStatus: before.payload.product,
            coldChanged: cold.payload.changed,
            coldRunning: running(coldStatus.payload),
            warmChanged: warm.payload.changed,
            restartSchema: restart.payload.schema,
            restartRunning: running(restartStatus.payload),
            stopped: stop.payload.changed,
          },
          latency: {
            unit: 'microseconds',
            daemonlessPlan: daemonless.durationUs,
            daemonlessStatus: before.durationUs,
            coldEnsure: cold.durationUs,
            coldReadyProbe: coldStatus.durationUs,
            warmEnsure: warm.durationUs,
            restart: restart.durationUs,
            restartReadyProbe: restartStatus.durationUs,
            stop: stop.durationUs,
          },
          nonClaims: [
            'universal performance SLO',
            'GUI interactive launch',
            'semantic capability readiness from process status',
            'physical-host crash or power-loss recovery',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (stop === null) {
      try {
        invoke(home, configHome, ['runtime', 'stop', '--json']);
      } catch (error) {
        console.error(
          `[runtime-product-smoke] cleanup failed: ${error.message}`,
        );
      }
    }
    // Windows can report the runtime stopped before the coordinator's log
    // handle has finished closing.  Let Node retry transient EBUSY/EPERM
    // failures instead of turning successful lifecycle cleanup into a smoke
    // failure.
    fs.rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 50 : 0,
      retryDelay: 100,
    });
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
