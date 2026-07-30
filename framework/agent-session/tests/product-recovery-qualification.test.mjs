import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CODEX_APP_SERVER_FEATURE_FLAG } from '../src/codex-app-server-product.mjs';
import { createDetachedAgentSessionHost } from '../src/product-client.mjs';

const PROVIDER = fileURLToPath(
  new URL('./fixtures/product-qualification-provider.mjs', import.meta.url),
);
const PROFILE_ROOT = `sha256:${'6'.repeat(64)}`;
const PRIVATE_VALUE = 'qualification-private-value-must-not-escape';
const require = createRequire(import.meta.url);

function preparedNodePty(root) {
  const source = path.dirname(require.resolve('node-pty/package.json'));
  const target = path.join(root, 'node-pty');
  cpSync(source, target, { recursive: true });
  if (process.platform === 'darwin') {
    const helper = path.join(
      target,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    chmodSync(helper, (statSync(helper).mode & 0o777) | 0o111);
  }
  return path.join(target, 'lib', 'index.js');
}

async function eventually(probe, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `${label} did not converge${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function sessionRef(suffix) {
  return {
    workConsoleId: `work:qualification:${suffix}`,
    sessionAttemptId: `attempt:qualification:${suffix}`,
  };
}

function qualificationEnvironment() {
  const environment = {
    KUNGFU_QUALIFICATION_PRIVATE: PRIVATE_VALUE,
  };
  if (process.platform !== 'win32') return environment;
  for (const requested of [
    'path',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    'temp',
    'tmp',
  ]) {
    const actual = Object.keys(process.env).find(
      (name) => name.toLowerCase() === requested,
    );
    if (actual && typeof process.env[actual] === 'string') {
      environment[actual] = process.env[actual];
    }
  }
  return environment;
}

function startInput(root, suffix) {
  return {
    ...sessionRef(suffix),
    provider: 'codex',
    providerVersion: '0.144.3',
    profileRoot: PROFILE_ROOT,
    executable: process.execPath,
    argv: [PROVIDER, 'codex'],
    cwd: root,
    env: qualificationEnvironment(),
  };
}

async function startSession(host, root, suffix) {
  const plan = await host.invoke({
    operation: 'plan-start',
    input: startInput(root, suffix),
  });
  return host.invoke({
    operation: 'start',
    actorId: 'qualification-controller',
    client: 'gui',
    plan,
    expectedPlanRoot: plan.root,
    attachment: {
      attachmentId: `view:${suffix}`,
      presentation: 'qualification-headless',
    },
    execution: {
      env: qualificationEnvironment(),
      cols: 100,
      rows: 30,
    },
  });
}

async function control(host, ref, operation, payload, automatic = true) {
  const plan = await host.invoke({
    operation: 'plan-control',
    controlOperation: operation,
    session: ref,
    payload,
  });
  return host.invoke({
    operation,
    actorId: 'qualification-controller',
    client: 'gui',
    plan,
    expectedPlanRoot: plan.root,
    payload,
    automatic,
  });
}

async function workerPid(metadata) {
  return eventually(async () => {
    const record = JSON.parse(await readFile(metadata, 'utf8'));
    return Number.isInteger(record.pid) ? record.pid : null;
  }, 'worker metadata');
}

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

test('detached product worker passes the retained recovery, privacy, and latency matrix', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-agent-session-qualification-'),
  );
  const workers = [];
  const providerPids = new Set();
  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, detached: false });
    workers.push(child);
    return child;
  };
  const options = {
    runtimeDir: root,
    executable: process.execPath,
    env: {
      ...process.env,
      [CODEX_APP_SERVER_FEATURE_FLAG]: '0',
      KUNGFU_AGENT_SESSION_NODE_PTY_MODULE: preparedNodePty(root),
    },
    spawnProcess,
    unrefWorker: false,
  };

  t.after(async () => {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }
    for (const pid of providerPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await Promise.all(
      workers.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => child.once('exit', resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });

  const firstMain = createDetachedAgentSessionHost(options);
  const retainedRef = sessionRef('retained-main-restart');
  await startSession(firstMain, root, 'retained-main-restart');
  const ready = await eventually(async () => {
    const status = await firstMain.invoke({
      operation: 'status',
      session: retainedRef,
    });
    return status.interactionState === 'ready' ? status : null;
  }, 'provider ready state');
  providerPids.add(ready.foreground.pid);

  const restartedMain = createDetachedAgentSessionHost(options);
  const reattached = await restartedMain.invoke({
    operation: 'status',
    session: retainedRef,
  });
  assert.equal(reattached.capsuleId, ready.capsuleId);
  assert.equal(
    reattached.foreground.processStartIdentity,
    ready.foreground.processStartIdentity,
  );
  assert.equal(workers.length, 1);

  const privateInstruction = { text: `continue ${PRIVATE_VALUE}` };
  const delivered = await control(
    restartedMain,
    retainedRef,
    'instruct',
    privateInstruction,
  );
  assert.equal(delivered.status, 'written');
  assert.doesNotMatch(JSON.stringify(delivered), new RegExp(PRIVATE_VALUE));
  assert.doesNotMatch(
    JSON.stringify(await restartedMain.invoke({ operation: 'list' })),
    new RegExp(PRIVATE_VALUE),
  );

  await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: retainedRef,
    });
    return status.interactionState === 'ready';
  }, 'ready state after instruction');
  await control(restartedMain, retainedRef, 'instruct', { text: '__burst__' });
  const overflow = await eventually(async () => {
    const snapshot = await restartedMain.invoke({
      operation: 'snapshot',
      session: retainedRef,
      requestedSequence: 0,
    });
    return snapshot.terminal.receipt.gap ? snapshot : null;
  }, 'bounded output gap');
  assert.equal(
    overflow.terminal.receipt.gap.reason,
    'bounded-retention-overflow',
  );
  assert.ok(overflow.terminal.receipt.nextSequence > 256 * 1024);

  const latencies = [];
  for (let index = 0; index < 40; index += 1) {
    const startedAt = performance.now();
    await restartedMain.invoke({ operation: 'list' });
    latencies.push(performance.now() - startedAt);
  }
  assert.ok(
    p95(latencies) < 250,
    `local list RPC p95 ${p95(latencies).toFixed(2)}ms exceeded 250ms`,
  );

  await control(restartedMain, retainedRef, 'instruct', { text: '__exit__' });
  await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: retainedRef,
    });
    return (
      status.lifecycleState === 'ended' && status.inputAdmission === 'closed'
    );
  }, 'provider exit closure');

  const lostRef = sessionRef('worker-loss');
  await startSession(restartedMain, root, 'worker-loss');
  const beforeLoss = await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: lostRef,
    });
    return status.interactionState === 'ready' ? status : null;
  }, 'second provider ready state');
  providerPids.add(beforeLoss.foreground.pid);
  const firstWorkerPid = await workerPid(restartedMain.metadata);
  assert.equal(firstWorkerPid, workers[0].pid);
  workers[0].kill('SIGTERM');
  await new Promise((resolve) => workers[0].once('exit', resolve));
  await eventually(() => {
    try {
      process.kill(beforeLoss.foreground.pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }, 'provider exit after worker shutdown');

  const afterLoss = await restartedMain.invoke({ operation: 'list' });
  assert.deepEqual(afterLoss.sessions, []);
  const lostConsole = afterLoss.consoles.find(
    (console) => console.consoleId === lostRef.workConsoleId,
  );
  assert.equal(
    lostConsole.attempts.find(
      (attempt) => attempt.sessionAttemptId === lostRef.sessionAttemptId,
    ).status,
    'unrecoverable',
  );
  const lostPresentation = afterLoss.attempts.find(
    (attempt) => attempt.sessionAttemptId === lostRef.sessionAttemptId,
  );
  assert.equal(lostPresentation.product.state, 'action-required');
  assert.equal(
    lostPresentation.product.recommendedAction,
    'start-new-attempt-or-provider-resume',
  );
  assert.equal(workers.length, 2);
  const lostStatus = await restartedMain.invoke({
    operation: 'status',
    session: lostRef,
  });
  assert.equal(lostStatus.live, false);
  assert.equal(lostStatus.lifecycleState, 'unrecoverable');
  assert.equal(lostStatus.inputAdmission, 'closed');

  const metrics = {
    schema: 'kungfu.agent-session.recovery-qualification/v1',
    platform: `${process.platform}-${process.arch}`,
    cases: {
      mainRestartReattach: 'passed',
      providerExitClosesInput: 'passed',
      workerLossStartsEmptyRuntime: 'passed',
      boundedOverflowGap: 'passed',
      portableReceiptPrivacy: 'passed',
    },
    localListRpc: {
      samples: latencies.length,
      p95Milliseconds: Number(p95(latencies).toFixed(3)),
      ceilingMilliseconds: 250,
    },
    linuxQualification: 'not-run',
    windowsQualification: 'not-run',
  };
  process.stdout.write(`qualification:${JSON.stringify(metrics)}\n`);
});
