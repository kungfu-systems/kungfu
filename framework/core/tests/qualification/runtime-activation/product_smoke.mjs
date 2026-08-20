// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../../../../project-cut/src/project-cut.mjs';

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

const RETIRED_ENVIRONMENT_PREFIX = ['_', 'PYI', '_'].join('');
const RETIRED_RESET_ENVIRONMENT = [
  'PY',
  'INSTALLER',
  '_RESET_ENVIRONMENT',
].join('');

function fileSha256(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function inspectProductLayout(
  productRoot,
  { platform = process.platform, environment = process.env } = {},
) {
  const entry = path.join(
    productRoot,
    platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  const trunk = path.join(
    productRoot,
    platform === 'win32' ? 'kungfu-trunk.exe' : 'kungfu-trunk',
  );
  const pythonRoot = path.join(productRoot, 'python');
  const interpreter =
    platform === 'win32'
      ? path.join(pythonRoot, 'python.exe')
      : path.join(pythonRoot, 'bin', 'python3');
  const markerPath = path.join(pythonRoot, 'kungfu-host.json');
  for (const required of [entry, trunk, interpreter, markerPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`assembled product path is missing: ${required}`);
    }
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (
    marker.schema !== 'kungfu.host/v1' ||
    marker.form !== 'assembled' ||
    marker.product_root !== '..'
  ) {
    throw new Error(`assembled host marker is invalid: ${markerPath}`);
  }
  const entryRoot = fileSha256(entry);
  const trunkRoot = fileSha256(trunk);
  if (entryRoot !== trunkRoot) {
    throw new Error('product entry bytes do not identify the Rust trunk');
  }
  const retiredEnvironmentKeys = Object.keys(environment).filter(
    (key) =>
      key === RETIRED_RESET_ENVIRONMENT ||
      key.startsWith(RETIRED_ENVIRONMENT_PREFIX),
  );
  if (retiredEnvironmentKeys.length) {
    throw new Error(
      `retired product packager state is present: ${retiredEnvironmentKeys.join(', ')}`,
    );
  }
  return {
    host: marker,
    entry: { kind: 'rust-trunk', sha256: entryRoot },
    python: {
      kind: 'python-build-standalone',
      interpreter: path.relative(productRoot, interpreter),
    },
    retiredPackagerEnvironmentKeys: [],
  };
}

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

export function invokeAfterIdentitySettlement(
  invokeCommand,
  home,
  configHome,
  args,
  { attempts = 50, wait = () => {} } = {},
) {
  let identityError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return invokeCommand(home, configHome, args);
    } catch (error) {
      if (
        !String(error?.message || error).includes('runtime_identity_unverified')
      ) {
        throw error;
      }
      identityError = error;
      try {
        invokeCommand(home, configHome, ['runtime', 'status', '--json']);
      } catch (statusError) {
        if (
          !String(statusError?.message || statusError).includes(
            'runtime_identity_unverified',
          )
        ) {
          throw statusError;
        }
        identityError = statusError;
      }
      wait();
    }
  }
  throw identityError;
}

export function runtimeReady(payload) {
  return (
    payload?.supervisor?.running === true &&
    payload?.supervisor?.identityVerified === true &&
    payload?.coordinator?.running === true &&
    payload?.coordinator?.identityVerified === true
  );
}

function waitForRunning(home, configHome) {
  let latest;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = invoke(home, configHome, ['runtime', 'status', '--json']);
    if (runtimeReady(latest.payload)) return latest;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const logs = [
    path.join(configHome, 'runtime', 'supervisor', 'supervisor.log'),
    path.join(home, 'runtime', 'coordinator', 'coordinator.log'),
  ]
    .map((logPath) => {
      try {
        const content = fs.readFileSync(logPath, 'utf8');
        return `${logPath}:\n${content.slice(-16_384)}`;
      } catch (error) {
        return `${logPath}: unavailable (${error.code || error.message})`;
      }
    })
    .join('\n');
  throw new Error(
    `product runtime did not become running: ${JSON.stringify(latest?.payload)}\n${logs}`,
  );
}

function main() {
  if (!fs.existsSync(EXECUTABLE)) {
    throw new Error(`assembled product executable is missing: ${EXECUTABLE}`);
  }
  const productLayout = inspectProductLayout(path.dirname(EXECUTABLE));
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-runtime-product-smoke-'),
  );
  const home = path.join(temporary, 'home');
  const configHome = path.join(temporary, 'config');
  let stop = null;
  try {
    const humanWorkDefinition = {
      objective: 'qualify installed neutral Work Design preflight',
    };
    const humanWorkDefinitionRoot = semanticRoot(humanWorkDefinition);
    const workDesignRequest = path.join(temporary, 'work-design-request.json');
    fs.writeFileSync(
      workDesignRequest,
      `${JSON.stringify({
        schema: 'kungfu.work-design.preflight-request/v1',
        humanWorkDefinition,
        humanWorkDefinitionRoot,
        selectionRequest: { objectiveRoot: humanWorkDefinitionRoot },
        adviceRequest: {},
        availability: { selector: 'unavailable', advisor: 'unavailable' },
      })}\n`,
    );
    const workDesign = invoke(home, configHome, [
      'work-design',
      'preflight',
      '--input',
      workDesignRequest,
    ]);
    if (
      workDesign.payload.schema !== 'kungfu.work-design.preflight/v1' ||
      workDesign.payload.outcome !== 'manual-capture' ||
      workDesign.payload.fallback?.reason !== 'selector-unavailable' ||
      workDesign.payload.operation?.mutates !== false
    ) {
      throw new Error('installed Work Design preflight contract drifted');
    }

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

    const cold = invokeAfterIdentitySettlement(
      invoke,
      home,
      configHome,
      ['runtime', 'ensure', '--json'],
      {
        wait: () =>
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100),
      },
    );
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
          productLayout,
          outcomes: {
            workDesignSchema: workDesign.payload.schema,
            workDesignOutcome: workDesign.payload.outcome,
            daemonlessStatus: before.payload.product,
            coldChanged: cold.payload.changed,
            coldRunning: runtimeReady(coldStatus.payload),
            warmChanged: warm.payload.changed,
            restartSchema: restart.payload.schema,
            restartRunning: runtimeReady(restartStatus.payload),
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
            workDesignPreflight: workDesign.durationUs,
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}
