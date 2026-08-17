import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { InProcessAgentSessionProductRuntime } from '../src/product-runtime.mjs';
import {
  AgentSessionProductSurface,
  createAgentSessionSurfaceClient,
} from '../src/product-surface.mjs';

const PROFILE_ROOT = `sha256:${'d'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 9001;
  }

  onData(listener) {
    this.on('data', listener);
  }

  onExit(listener) {
    this.on('exit', listener);
  }

  write() {}

  resize() {}

  kill() {}
}

test('product status change waits for the next Capsule event', async () => {
  const child = new FakePtyProcess();
  const runtime = new InProcessAgentSessionProductRuntime({
    pty: { spawn: () => child },
    now: () => 5000,
  });
  const surface = new AgentSessionProductSurface({
    runtime,
    now: () => 6000,
    makeId: () => 'status-event-test',
  });
  const client = createAgentSessionSurfaceClient({
    invoke: (request) => surface.invoke(request),
    client: 'gui',
    actorId: 'operator-status-event',
  });
  const input = {
    workConsoleId: 'assistant:status-event',
    sessionAttemptId: 'attempt:status-event:1',
    provider: 'codex',
    providerVersion: 'diagnostic-only',
    profileRoot: `sha256:${'d'.repeat(64)}`,
    executable: '/usr/local/bin/codex',
    argv: ['--no-alt-screen'],
    cwd: '/workspace',
    env: { HOME: '/home/test', PATH: '/usr/local/bin' },
  };
  const plan = client.planStart(input);
  client.start(
    plan,
    {
      attachmentId: 'view:status-event',
      presentation: 'assistant-console',
    },
    { env: input.env, cols: 100, rows: 30 },
  );

  const initial = await surface.invoke({ operation: 'status', session: input });
  const changedPromise = surface.invoke({
    operation: 'wait-status-change',
    session: input,
    afterChangeSequence: initial.changeSequence,
  });
  child.emit('data', 'provider output');
  const changed = await changedPromise;

  assert.equal(changed.changeSequence, initial.changeSequence + 1);
  assert.equal(
    changed.output.nextSequence,
    Buffer.byteLength('provider output'),
  );
});

test('controlled end settles before the product status becomes reviewable', async () => {
  const child = new FakePtyProcess(9001);
  const spawns = [];
  const runtime = new InProcessAgentSessionProductRuntime({
    pty: {
      spawn(executable, argv, options) {
        spawns.push({ executable, argv, options });
        return child;
      },
    },
    now: () => 5000,
  });
  const surface = new AgentSessionProductSurface({
    runtime,
    now: () => 6000,
    makeId: () => 'runtime-test',
  });
  const client = createAgentSessionSurfaceClient({
    invoke: (request) => surface.invoke(request),
    client: 'gui',
    actorId: 'operator-runtime',
  });
  const input = {
    workConsoleId: 'assistant:workspace-runtime',
    sessionAttemptId: 'attempt:runtime:1',
    provider: 'codex',
    providerVersion: '0.146.0',
    profileRoot: PROFILE_ROOT,
    executable: '/usr/local/bin/codex',
    argv: ['--no-alt-screen'],
    cwd: '/workspace',
    env: { HOME: '/home/test', PATH: '/usr/local/bin' },
  };
  const result = client.start(
    client.planStart(input),
    { attachmentId: 'view:runtime', presentation: 'assistant-console' },
    { env: input.env, cols: 100, rows: 30 },
  );

  assert.equal(result.status, 'started');
  assert.deepEqual(spawns, [
    {
      executable: input.executable,
      argv: input.argv,
      options: {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: input.cwd,
        env: input.env,
      },
    },
  ]);
  assert.equal(runtime.list()[0].host.status().lifecycleState, 'ready');

  const session = {
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  };
  const ending = client.control(client.planControl('end', session, {}), {});
  child.emit('exit', { exitCode: 1, signal: 0 });
  await ending;

  const ended = client.show(session);
  assert.equal(ended.exit.exitCode, 1);
  assert.deepEqual(ended.exit.controlRequest, {
    operation: 'end',
    signal: 'SIGTERM',
  });
  assert.equal(ended.workAgent.attention.kind, 'ready-for-review');
});
