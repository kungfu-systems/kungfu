import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createDetachedAgentSessionHost,
  prepareAgentSessionNodePty,
} from '../src/product-client.mjs';

const MOCK = fileURLToPath(
  new URL('../src/mock-provider.mjs', import.meta.url),
);
const PROFILE_ROOT = `sha256:${'7'.repeat(64)}`;
const CONVERGENCE_TIMEOUT_MS = 5000;
const STARTUP_CONVERGENCE_TIMEOUT_MS = 60000;

async function eventually(
  probe,
  label,
  timeoutMs = CONVERGENCE_TIMEOUT_MS,
  diagnostic = () => '',
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(25);
  }
  const detail = diagnostic();
  throw new Error(
    `${label} did not converge within ${timeoutMs}ms${detail ? `; ${detail}` : ''}`,
  );
}

function mockProviderEnvironment({
  platform = process.platform,
  source = process.env,
} = {}) {
  if (platform !== 'win32') return { PATH: source.PATH ?? '' };
  const environment = {};
  for (const requested of [
    'path',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    'temp',
    'tmp',
  ]) {
    const actual = Object.keys(source).find(
      (name) => name.toLowerCase() === requested,
    );
    if (actual && typeof source[actual] === 'string') {
      environment[actual] = source[actual];
    }
  }
  return environment;
}

async function control(host, session, operation, payload, automatic = true) {
  const plan = await host.invoke({
    operation: 'plan-control',
    controlOperation: operation,
    session,
    payload,
  });
  return host.invoke({
    operation,
    actorId: 'mock-qualification',
    client: 'cli',
    plan,
    expectedPlanRoot: plan.root,
    payload,
    automatic,
  });
}

test('convergence timeout includes its last observed diagnostic', async () => {
  await assert.rejects(
    eventually(
      async () => null,
      'fixture state',
      1,
      () => 'last lifecycle=ready, interaction=busy',
    ),
    /fixture state did not converge within 1ms; last lifecycle=ready, interaction=busy/u,
  );
});

test('Windows Mock Agent environment preserves required names and their casing', () => {
  const source = {
    Path: 'C:\\tools',
    SYSTEMROOT: 'C:\\Windows',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    TEMP: 'C:\\Temp',
    Tmp: 'C:\\Temp',
    KUNGFU_UNREVIEWED_SECRET: 'omit',
  };
  assert.deepEqual(mockProviderEnvironment({ platform: 'win32', source }), {
    Path: source.Path,
    SYSTEMROOT: source.SYSTEMROOT,
    windir: source.windir,
    ComSpec: source.ComSpec,
    PATHEXT: source.PATHEXT,
    TEMP: source.TEMP,
    Tmp: source.Tmp,
  });
});

test('macOS node-pty preparation rejects a linked private support target', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('private spawn-helper preparation is macOS-specific');
    return;
  }
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-node-pty-support-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const packageRoot = path.join(root, 'source-node-pty');
  const linkedTarget = path.join(
    runtimeDir,
    'agent-session-support',
    'node-pty',
  );
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true });
  await mkdir(
    path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`),
    { recursive: true },
  );
  await writeFile(path.join(packageRoot, 'lib', 'index.js'), 'export {};\n');
  await writeFile(
    path.join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    ),
    'fixture\n',
    { mode: 0o600 },
  );
  await mkdir(path.dirname(linkedTarget), { recursive: true });
  await symlink(packageRoot, linkedTarget, 'dir');

  assert.throws(
    () =>
      prepareAgentSessionNodePty({
        runtimeDir,
        modulePath: path.join(packageRoot, 'lib', 'index.js'),
      }),
    /must be a real directory/u,
  );
});

test('deterministic Mock Agent traverses answer, approval, review, and exit in the detached product runtime', async (t) => {
  const runtimeDir = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-mock-product-session-'),
  );
  const ptyModule = prepareAgentSessionNodePty({ runtimeDir });
  if (process.platform === 'darwin') {
    assert.equal(ptyModule.startsWith(runtimeDir), true);
    assert.equal(
      lstatSync(path.dirname(path.dirname(ptyModule))).isSymbolicLink(),
      false,
    );
  }
  const workers = [];
  const host = createDetachedAgentSessionHost({
    runtimeDir,
    env: {
      ...process.env,
      KUNGFU_AGENT_SESSION_NODE_PTY_MODULE: ptyModule,
    },
    unrefWorker: false,
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, { ...options, detached: false });
      workers.push(child);
      return child;
    },
  });
  t.after(async () => {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const session = {
    workConsoleId: 'work:kungfu.work-control:assignment:mock-flow',
    sessionAttemptId: 'attempt:mock-flow:1',
  };
  const providerEnvironment = mockProviderEnvironment();
  const input = {
    ...session,
    workspaceId: 'workspace:mock-flow',
    provider: 'synthetic',
    providerVersion: '1.0.0',
    profileRoot: PROFILE_ROOT,
    executable: process.execPath,
    argv: [MOCK, '--scenario', 'multi-step'],
    cwd: runtimeDir,
    env: providerEnvironment,
    runtimeProfileId: 'kungfu.mock-agent.multi-step',
    binding: {
      kind: 'work',
      workRef: {
        schema: 'kungfu.work-ref/v1',
        workspaceId: 'workspace:mock-flow',
        profileId: 'kungfu.work-control',
        profileRoot: PROFILE_ROOT,
        entityType: 'assignment',
        entityId: 'mock-flow',
        entityRoot: `sha256:${'e'.repeat(64)}`,
        purpose: 'qualification',
        systemTimeCut: '2026-08-02T00:00:00Z',
        initiativeId: 'mock-flow-initiative',
      },
    },
  };
  const plan = await host.invoke({ operation: 'plan-start', input });
  await host.invoke({
    operation: 'start',
    actorId: 'mock-qualification',
    client: 'cli',
    plan,
    expectedPlanRoot: plan.root,
    attachment: { attachmentId: 'mock-view', presentation: 'qualification' },
    execution: { env: input.env, cols: 100, rows: 30 },
  });

  let lastInitialStatus = null;
  await eventually(
    async () => {
      const status = await host.invoke({ operation: 'status', session });
      lastInitialStatus = status;
      return status.interactionState === 'ready' ? status : null;
    },
    'initial ready state',
    STARTUP_CONVERGENCE_TIMEOUT_MS,
    () =>
      lastInitialStatus
        ? `last lifecycle=${lastInitialStatus.lifecycleState}, interaction=${lastInitialStatus.interactionState}`
        : 'no status observed',
  );
  await control(host, session, 'instruct', { text: 'perform bounded Work' });
  const answer = await eventually(async () => {
    const status = await host.invoke({ operation: 'status', session });
    return status.workAgent?.attention?.kind === 'needs-answer' ? status : null;
  }, 'answer attention');
  assert.equal(answer.workAgent.attempt, 'waiting');

  await control(host, session, 'instruct', { text: 'alpha' });
  const approval = await eventually(async () => {
    const status = await host.invoke({ operation: 'status', session });
    return status.workAgent?.attention?.kind === 'needs-approval'
      ? status
      : null;
  }, 'approval attention');
  assert.equal(approval.product.state, 'action-required');

  await control(host, session, 'send-key', { key: 'y' }, false);
  await control(host, session, 'send-key', { key: 'Enter' }, false);
  const review = await eventually(async () => {
    const status = await host.invoke({ operation: 'status', session });
    return status.interactionState === 'ready' ? status : null;
  }, 'review boundary');
  assert.equal(review.workAgent.attention.kind, 'ready-for-review');
  const snapshot = await host.invoke({
    operation: 'snapshot',
    session,
    requestedSequence: 0,
  });
  assert.match(snapshot.terminal.vt.lines.join('\n'), /READY FOR REVIEW/u);

  await control(host, session, 'end', {});
  const ended = await host.invoke({ operation: 'status', session });
  assert.equal(ended.lifecycleState, 'ended');
  assert.equal(ended.live, false);
  assert.equal(ended.controllable, false);
  assert.equal(ended.terminalObservable, true);
  const listed = await host.invoke({ operation: 'list' });
  const attempt = listed.attempts.find(
    (candidate) => candidate.sessionAttemptId === session.sessionAttemptId,
  );
  assert.equal(attempt.live, false);
  assert.equal(attempt.controllable, false);
});
