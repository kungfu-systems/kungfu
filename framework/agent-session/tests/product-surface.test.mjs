import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { AgentSessionCapsuleHost } from '../src/capsule-host.mjs';
import { AgentSessionInteractionPort } from '../src/interaction-port.mjs';
import {
  AgentSessionCapsulePeerTransport,
  InMemoryJournalNoticePort,
} from '../src/peer-transport.mjs';
import { bindAgentSessionSurfaceRpc } from '../src/product-rpc.mjs';
import { InProcessAgentSessionProductRuntime } from '../src/product-runtime.mjs';
import {
  AgentSessionProductSurface,
  agentSessionProductState,
  createAgentSessionSurfaceClient,
} from '../src/product-surface.mjs';
import { createProviderAdapter } from '../src/provider-adapters.mjs';
import {
  JsonFileWorkConsoleRegistryStore,
  WORK_CONSOLE_REGISTRY_SCHEMA,
  WorkConsoleRegistry,
} from '../src/work-console-registry.mjs';

const PROFILE_ROOT = `sha256:${'d'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.writes = [];
    this.signals = [];
  }

  onData(listener) {
    this.on('data', listener);
  }

  onExit(listener) {
    this.on('exit', listener);
  }

  write(data) {
    this.writes.push(data);
  }

  resize() {}

  kill(signal) {
    this.signals.push(signal);
  }
}

class SyntheticProductRuntime {
  constructor() {
    this.sessions = new Map();
    this.spawnCount = 0;
    this.sequence = 0;
  }

  list() {
    return [...this.sessions.values()];
  }

  get(ref) {
    return this.sessions.get(ref.sessionAttemptId) ?? null;
  }

  start(plan) {
    this.spawnCount += 1;
    const child = new FakePtyProcess(7000 + this.spawnCount);
    const host = new AgentSessionCapsuleHost({
      pty: { spawn: () => child },
      capsuleId: `capsule:${plan.sessionAttemptId}`,
      runtimeIdentity: 'runtime:product-surface',
      maxOutputBytes: 4096,
      now: () => 1000 + this.sequence++,
    });
    const started = host.start({
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
      capsuleGeneration: '1',
      sessionStreamEpoch: '1',
      provider: plan.provider,
      profileRoot: plan.profileRoot,
      executable: plan.executable,
      argv: plan.argv,
      cwd: plan.cwd ?? undefined,
    });
    const transport = new AgentSessionCapsulePeerTransport({
      host,
      port: new InMemoryJournalNoticePort(),
      now: () => 2000 + this.sequence++,
    });
    transport.register({ coordinatorEpoch: '1', supervisorGeneration: '1' });
    const port = new AgentSessionInteractionPort({
      host,
      transport,
      adapter: createProviderAdapter({
        provider: plan.provider,
        version: plan.providerVersion,
      }),
      now: () => 3000 + this.sequence++,
    });
    const session = {
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
      binding: plan.binding,
      host,
      transport,
      port,
      child,
      attachments: new Map(),
      authority(actorId) {
        const controller = transport.status().controllerLease;
        return {
          leaseId: controller?.leaseId,
          holderId: actorId,
          coordinatorEpoch: '1',
          expectedForeground: started.foreground,
          sessionAttemptId: plan.sessionAttemptId,
          capsuleGeneration: '1',
          sessionStreamEpoch: '1',
          processStartIdentity: started.foreground.processStartIdentity,
        };
      },
      end(request) {
        const controlReceipt = transport.submitSignal({
          ...request,
          signal: 'SIGTERM',
        });
        return { status: controlReceipt.status, controlReceipt };
      },
    };
    this.sessions.set(plan.sessionAttemptId, session);
    return session;
  }
}

function fixture() {
  const runtime = new SyntheticProductRuntime();
  let id = 0;
  const surface = new AgentSessionProductSurface({
    runtime,
    now: () => 4000 + id,
    makeId: () => `id-${++id}`,
  });
  const invoke = (request) => surface.invoke(request);
  const clients = Object.fromEntries(
    ['gui', 'cli', 'kfd3-agent'].map((client) => [
      client,
      createAgentSessionSurfaceClient({
        invoke,
        client,
        actorId: 'operator-1',
      }),
    ]),
  );
  const input = {
    workConsoleId: 'work:mission-control:go:go-42',
    sessionAttemptId: 'attempt:go-42:1',
    provider: 'codex',
    providerVersion: '0.144.3',
    profileRoot: PROFILE_ROOT,
    executable: '/usr/local/bin/codex',
    argv: ['--no-alt-screen'],
    cwd: '/workspace',
    env: { PATH: '/redacted', HOME: '/redacted' },
    binding: {
      kind: 'work',
      workRef: {
        schema: 'kungfu.work-ref/v1',
        workspaceId: 'workspace-1',
        profileId: 'kungfu.mission-control',
        profileRoot: PROFILE_ROOT,
        entityType: 'go',
        entityId: 'go-42',
        entityRoot: `sha256:${'e'.repeat(64)}`,
        purpose: 'delegated-work',
        systemTimeCut: '2026-07-14T09:00:00Z',
      },
    },
  };
  return { clients, input, runtime, surface };
}

test('product state hides process topology and reserves action-required for unsafe recovery', () => {
  assert.deepEqual(
    agentSessionProductState({
      live: true,
      lifecycleState: 'ready',
      interactionState: 'busy',
    }),
    {
      schema: 'kungfu.agent-session.product-state/v1',
      state: 'working',
      reason: 'provider-working',
      recommendedAction: null,
    },
  );
  assert.deepEqual(
    agentSessionProductState({ attemptStatus: 'unrecoverable' }),
    {
      schema: 'kungfu.agent-session.product-state/v1',
      state: 'action-required',
      reason: 'prior-attempt-cannot-be-reattached',
      recommendedAction: 'start-new-attempt-or-provider-resume',
    },
  );
  assert.equal(
    agentSessionProductState({
      live: true,
      lifecycleState: 'ready',
      interactionState: 'unknown',
      providerCompatible: true,
    }).state,
    'recovering',
  );
});

test('Core resolves one primary WorkConsole for a generic WorkRef', () => {
  const { clients, input } = fixture();
  const first = clients.gui.resolveConsole({
    binding: input.binding,
    workspaceId: 'ignored-for-work-binding',
  });
  const second = clients.cli.resolveConsole({
    binding: input.binding,
    workspaceId: 'ignored-for-work-binding',
  });
  assert.deepEqual(first, second);
  assert.equal(first.workConsoleId, 'work:kungfu.mission-control:go:go-42');
  assert.equal(first.binding.workRef.entityType, 'go');
});

function invokeRpc(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      pending += chunk;
      if (!pending.includes('\n')) return;
      socket.end();
      resolve(JSON.parse(pending.slice(0, pending.indexOf('\n'))));
    });
    socket.on('error', reject);
  });
}

test('GUI, CLI, and KFD-3 produce the exact same reviewed start plan', () => {
  const { clients, input } = fixture();
  const plans = Object.values(clients).map((client) => client.planStart(input));
  assert.deepEqual(plans[0], plans[1]);
  assert.deepEqual(plans[1], plans[2]);
  assert.deepEqual(plans[0].environmentNames, ['HOME', 'PATH']);
  assert.doesNotMatch(JSON.stringify(plans[0]), /\/redacted/u);
  assert.deepEqual(plans[0].workEffects, []);
});

test('one Go action starts once, auto-attaches, and later views reuse the Capsule', () => {
  const { clients, input, runtime } = fixture();
  const firstPlan = clients.gui.planStart(input);
  const first = clients.gui.start(firstPlan, {
    attachmentId: 'view:go-card',
    presentation: 'go-card-side-console',
  });
  assert.equal(first.status, 'started');
  assert.equal(first.autoAttached, true);
  assert.equal(first.attachReceipt.controller, true);
  assert.equal(runtime.spawnCount, 1);
  const registry = clients.cli.list();
  assert.equal(registry.consoles.length, 1);
  assert.equal(registry.attempts[0].product.state, 'recovering');
  assert.equal(registry.consoles[0].attempts[0].status, 'running');
  assert.equal(
    registry.consoles[0].attempts[0].receipts.some(
      (receipt) => receipt.operation === 'start',
    ),
    true,
  );

  const secondPlan = clients.cli.planStart({
    ...input,
    provider: 'claude',
    providerVersion: '2.1.209',
    executable: '/usr/local/bin/claude',
  });
  assert.equal(secondPlan.operation, 'attach-existing');
  assert.equal(secondPlan.provider, 'codex');
  assert.equal(secondPlan.executable, '/usr/local/bin/codex');
  assert.deepEqual(secondPlan.environmentNames, []);
  const second = clients.cli.start(secondPlan, {
    attachmentId: 'view:cli',
    presentation: 'headless',
  });
  assert.equal(second.status, 'reused');
  assert.equal(runtime.spawnCount, 1);

  clients['kfd3-agent'].attach(
    {
      workConsoleId: input.workConsoleId,
      sessionAttemptId: input.sessionAttemptId,
    },
    { attachmentId: 'view:assistant', presentation: 'assistant-console' },
  );
  const status = clients.gui.show({
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  });
  assert.equal(status.attachments.length, 3);
  assert.equal(status.controller.holderId, 'operator-1');
  assert.equal(status.workOutcome, null);
  assert.equal(status.proof, null);
});

test('all clients see one Hub projection and presentation detach never ends the provider', () => {
  const { clients, input, runtime } = fixture();
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:go-card',
    presentation: 'go-card-side-console',
  });
  const projections = Object.values(clients).map((client) => client.list());
  assert.deepEqual(projections[0], projections[1]);
  assert.deepEqual(projections[1], projections[2]);
  assert.equal(projections[0].sessions.length, 1);

  const detached = clients.gui.detach(
    {
      workConsoleId: input.workConsoleId,
      sessionAttemptId: input.sessionAttemptId,
    },
    'view:go-card',
  );
  assert.equal(detached.providerEnded, false);
  assert.equal(runtime.list()[0].host.status().lifecycleState, 'ready');
  assert.deepEqual(runtime.list()[0].child.signals, []);
  const registered = clients.cli.list().consoles[0].attempts[0];
  assert.equal(registered.status, 'running');
  assert.equal(registered.receipts.at(-1).operation, 'detach');
});

test('a provider restart creates a new attempt under the same primary WorkConsole', () => {
  const { clients, input, runtime } = fixture();
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:first-attempt',
    presentation: 'headless',
  });
  runtime.list()[0].child.emit('exit', { exitCode: 0, signal: 0 });
  const secondInput = {
    ...input,
    sessionAttemptId: 'attempt:go-42:2',
  };
  clients.cli.start(clients.cli.planStart(secondInput), {
    attachmentId: 'view:second-attempt',
    presentation: 'headless',
  });
  const registry = clients['kfd3-agent'].list().consoles;
  assert.equal(registry.length, 1);
  assert.equal(registry[0].consoleId, input.workConsoleId);
  assert.deepEqual(
    registry[0].attempts.map((attempt) => attempt.sessionAttemptId),
    [input.sessionAttemptId, secondInput.sessionAttemptId],
  );
  assert.deepEqual(
    registry[0].attempts.map((attempt) => attempt.status),
    ['exited', 'running'],
  );
});

test('the durable Core registry migrates view-owned v1 data without presentation authority', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-console-registry-'),
  );
  const file = path.join(root, 'work-console-registry.json');
  try {
    const legacy = {
      schema: 'kungfu.work-console-registry/v1',
      workspaceId: 'workspace-legacy',
      consoles: [
        {
          consoleId: 'assistant:workspace-legacy',
          bindingKind: 'workspace-assistant',
          workRef: null,
          runtimeProfileId: 'codex-app',
          backend: 'capsule',
          attempts: [
            {
              attemptId: 'attempt:legacy',
              runId: 'attempt:legacy',
              status: 'running',
              startedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      presentation: {
        tabs: ['assistant:workspace-legacy'],
        splits: [],
        drawer: 'assistant:workspace-legacy',
        windows: [],
      },
    };
    const store = new JsonFileWorkConsoleRegistryStore(file);
    store.save(legacy);
    const registry = new WorkConsoleRegistry({ store, now: () => 2 });
    const snapshot = registry.snapshot();
    assert.equal(snapshot.schema, WORK_CONSOLE_REGISTRY_SCHEMA);
    assert.equal(snapshot.consoles[0].attempts[0].status, 'unrecoverable');
    assert.equal(snapshot.consoles[0].attempts[0].endedAt, 2);
    assert.equal(
      snapshot.consoles[0].attempts[0].receipts[0].reason,
      'worker-runtime-continuity-lost',
    );
    assert.equal('presentation' in snapshot, false);
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /tabs|splits|drawer|windows/u,
    );
    const historical = new AgentSessionProductSurface({
      runtime: new SyntheticProductRuntime(),
      registry,
    }).show({
      workConsoleId: 'assistant:workspace-legacy',
      sessionAttemptId: 'attempt:legacy',
    });
    assert.equal(historical.live, false);
    assert.equal(historical.lifecycleState, 'unrecoverable');
    assert.equal(historical.binding.kind, 'workspace-assistant');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Terminal persistence contains presentation references but no Console authority', async () => {
  const source = await readFile(
    new URL(
      '../../../extensions/terminal/src/view/persistence.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /type WorkConsoleRegistry|type SessionAttempt|CONSOLE_REGISTRY_LOCATION|saveConsoleRegistry/u,
  );
  assert.match(source, /consoleId\?: string/u);
  assert.match(source, /attemptId\?: string/u);
});

test('Terminal WorkRef launch remains Profile-neutral and rejects partial identity', async () => {
  const source = await readFile(
    new URL('../../../extensions/terminal/src/view/index.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /kungfu\.mission-control/u);
  assert.match(
    source,
    /WorkRef launch requires workProfileId, workProfileRoot, and workEntityId/u,
  );
  assert.match(source, /profileId: params\.workProfileId/u);
});

test('the published v2 schema admits the Core registry and excludes presentation', async () => {
  const { clients, input } = fixture();
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:schema',
    presentation: 'headless',
  });
  const schema = JSON.parse(
    await readFile(
      new URL('../schemas/work-console-registry.schema.json', import.meta.url),
      'utf8',
    ),
  );
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const registry = {
    schema: WORK_CONSOLE_REGISTRY_SCHEMA,
    consoles: clients.cli.list().consoles,
  };
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
  assert.equal('presentation' in schema.properties, false);
});

test('provider exit metadata remains visible without retaining terminal output', () => {
  const { clients, input, runtime } = fixture();
  const ref = {
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  };
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:go-card',
    presentation: 'go-card-side-console',
  });
  runtime.list()[0].child.emit('exit', { exitCode: 64, signal: 0 });
  const status = clients.cli.show(ref);
  assert.equal(status.lifecycleState, 'ended');
  assert.equal(status.inputAdmission, 'closed');
  assert.equal(status.exit.exitCode, 64);
  assert.equal(status.exit.signal, 0);
  assert.doesNotMatch(JSON.stringify(status.exit), /terminal|stderr|output/iu);
});

test('controller lease has one winner and transfers only after exact release', () => {
  const { clients, input, runtime, surface } = fixture();
  const ref = {
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  };
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:controller-1',
    presentation: 'go-card-side-console',
  });
  const observer = createAgentSessionSurfaceClient({
    invoke: (request) => surface.invoke(request),
    client: 'cli',
    actorId: 'operator-2',
  });
  observer.attach(
    ref,
    { attachmentId: 'view:controller-2', presentation: 'headless' },
    false,
  );

  const deniedPlan = observer.planControl('acquire-control', ref, {});
  const denied = observer.control(deniedPlan, {}, false);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.controlReceipt.reason, 'controller-held');
  assert.equal(clients.gui.show(ref).controller.holderId, 'operator-1');

  const released = clients.gui.releaseControl(ref);
  assert.equal(released.status, 'released');
  assert.equal(clients.gui.show(ref).controller, null);
  assert.throws(
    () => observer.control(deniedPlan, {}, false),
    (error) => error.code === 'stale_plan',
  );
  const acquired = observer.acquireControl(ref);
  assert.equal(acquired.status, 'granted');
  assert.equal(observer.show(ref).controller.holderId, 'operator-2');

  runtime.list()[0].child.emit('data', '\u001b[2J\u001b[H› Ready');
  const payload = { text: 'Continue after an explicit lease transfer' };
  const delivered = observer.control(
    observer.planControl('instruct', ref, payload),
    payload,
    true,
  );
  assert.equal(delivered.status, 'written');
});

test('Agent instruction uses the shared plan and receipt without claiming work outcome', () => {
  const { clients, input, runtime } = fixture();
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:go-card',
    presentation: 'go-card-side-console',
  });
  const session = {
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  };
  runtime.list()[0].child.emit('data', '\u001b[2J\u001b[H› Ready');
  const payload = {
    text: 'Inspect the current Go through public Profile actions',
    mode: 'when-ready',
  };
  const plans = Object.values(clients).map((client) =>
    client.planControl('instruct', session, payload),
  );
  assert.deepEqual(plans[0], plans[1]);
  assert.deepEqual(plans[1], plans[2]);

  const result = clients['kfd3-agent'].control(plans[2], payload, true);
  assert.equal(result.status, 'written');
  assert.equal(
    result.deliveryReceipt.proves,
    'validated-input-written-to-pty-only',
  );
  assert.equal(result.semanticOutcome, null);
  assert.equal(result.workState, null);
  assert.equal(result.proof, null);
  assert.doesNotMatch(JSON.stringify(result), /Inspect the current Go/u);
  assert.equal(runtime.list()[0].child.writes.length, 1);
});

test('approval state holds shared automatic instruction and stale plans fail closed', () => {
  const { clients, input, runtime } = fixture();
  clients.gui.start(clients.gui.planStart(input), {
    attachmentId: 'view:go-card',
    presentation: 'go-card-side-console',
  });
  const session = {
    workConsoleId: input.workConsoleId,
    sessionAttemptId: input.sessionAttemptId,
  };
  const payload = { text: 'Continue automatically', mode: 'queue' };
  const plan = clients.gui.planControl('instruct', session, payload);
  runtime
    .list()[0]
    .child.emit('data', '\u001b[2J\u001b[HWould you like to run this command?');
  const held = clients.gui.control(plan, payload, true);
  assert.equal(held.status, 'held');
  assert.match(held.reason, /approval-needed/u);
  assert.deepEqual(runtime.list()[0].child.writes, []);

  assert.throws(
    () =>
      clients.gui.control({ ...plan, coordinatorEpoch: '2' }, payload, true),
    (error) => error.code === 'plan_root_mismatch',
  );
});

test('the product runtime executes a reviewed plan through the real Capsule host', () => {
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
    providerVersion: '0.144.3',
    profileRoot: PROFILE_ROOT,
    executable: '/usr/local/bin/codex',
    argv: ['--no-alt-screen'],
    cwd: '/workspace',
    env: { HOME: '/home/test', PATH: '/usr/local/bin' },
  };
  const plan = client.planStart(input);
  const result = client.start(
    plan,
    { attachmentId: 'view:runtime', presentation: 'assistant-console' },
    { env: input.env, cols: 100, rows: 30 },
  );

  assert.equal(result.status, 'started');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], {
    executable: input.executable,
    argv: input.argv,
    options: {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: input.cwd,
      env: input.env,
    },
  });
  assert.equal(runtime.list()[0].host.status().lifecycleState, 'ready');
});

test('the local product RPC preserves the same action and error envelopes', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-agent-session-product-rpc-'),
  );
  const endpoint = path.join(directory, 'surface.sock');
  const { surface } = fixture();
  const rpc = bindAgentSessionSurfaceRpc({
    endpoint,
    invoke: (request) => surface.invoke(request),
  });
  await rpc.ready;
  if (process.platform !== 'win32') {
    assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
  }
  t.after(async () => {
    await rpc.close();
    await rm(directory, { recursive: true });
  });

  const success = await invokeRpc(endpoint, { operation: 'capabilities' });
  assert.equal(success.ok, true);
  assert.equal(
    success.value.schema,
    'kungfu.agent-session.surface-capabilities/v1',
  );
  const failure = await invokeRpc(endpoint, { operation: 'not-an-action' });
  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: 'unknown_operation',
      message: "unknown Agent Session operation 'not-an-action'",
    },
  });
});
