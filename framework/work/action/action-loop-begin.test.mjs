// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  beginActionLoop,
  checkpointActionLoop,
  createCorePublicAdapters,
  createExplicitCompatibilityAdapters,
  resumeActionLoop,
} from './action-loop-begin.mjs';
import { rootStepReceipt } from './action-loop.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, 'action-loop.contract.json'), 'utf8'),
);
const WORKER = path.join(DIR, 'fixtures', 'action-loop-resume-worker.mjs');
const NATIVE_WORKER = path.join(
  DIR,
  'fixtures',
  'action-loop-native-resume-worker.mjs',
);
const NATIVE_BINDING_DIR = path.join(
  DIR,
  '..',
  '..',
  'core',
  'build',
  'python',
);
const HAS_NATIVE_BINDING =
  fs.existsSync(NATIVE_BINDING_DIR) &&
  fs
    .readdirSync(NATIVE_BINDING_DIR)
    .some(
      (name) =>
        name.startsWith('pykungfu.') &&
        (name.endsWith('.so') || name.endsWith('.pyd')),
    );

function root(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stepReceipt(request, stepId, source) {
  return rootStepReceipt({
    schema: contract.stepReceipt.schema,
    loopId: request.loopId,
    stepId,
    idempotencyKey: request.idempotencyKey,
    status: 'accepted',
    preconditionRoots: [request.loopRoot],
    resultRoots: [root(`${source}:${stepId}:result`)],
    authorityReceiptRoot: root(`${source}:${stepId}`),
  });
}

function request(overrides = {}) {
  return {
    schema: 'kungfu.action-loop.begin-request/v0',
    loopId: 'loop:begin-resume',
    loopRoot: root('loop'),
    loopRef: 'action-loop/begin-resume',
    idempotencyKey: 'begin-resume-v0',
    factRef: {
      name: 'action-loop/begin-resume',
      cutRoot: null,
      revision: 0,
    },
    pursuit: {
      explicit: true,
      binding: { id: 'pursuit:go', root: root('pursuit'), state: 'active' },
    },
    atlas: {
      binding: { id: 'atlas:xinfa', root: root('atlas'), state: 'current' },
      verification: {
        valid: true,
        atlasRoot: root('atlas'),
        diagnostics: [],
      },
    },
    warrant: {
      explicit: true,
      binding: {
        id: 'warrant:bounded',
        root: root('warrant'),
        state: 'issued',
      },
    },
    episode: {
      id: 'episode:runtime',
      source: 'action-loop:begin-resume-v0',
    },
    fact: { id: 'fact:loop', root: root('input-fact'), state: 'declared' },
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class MemoryCheckpointStore {
  constructor() {
    this.rows = new Map();
    this.saves = 0;
  }

  async load(loopRef) {
    return this.rows.has(loopRef)
      ? { status: 'current', ...clone(this.rows.get(loopRef)) }
      : { status: 'absent' };
  }

  async save(checkpoint) {
    const current = this.rows.get(checkpoint.loopRef);
    const actual = current?.envelope.factRef ?? {
      name: checkpoint.expectedOld.name,
      cutRoot: checkpoint.expectedOld.cutRoot,
      revision: checkpoint.expectedOld.revision,
    };
    if (
      actual.cutRoot !== checkpoint.expectedOld.cutRoot ||
      actual.revision !== checkpoint.expectedOld.revision
    ) {
      return {
        status: 'denied',
        code: 'stale-ref',
        message: 'Fact ref differs from expected-old',
        writeOccurred: false,
      };
    }
    this.saves += 1;
    const factRef = {
      name: checkpoint.expectedOld.name,
      cutRoot: root(`checkpoint:${this.saves}`),
      revision: checkpoint.expectedOld.revision + 1,
    };
    const envelope = clone(checkpoint.envelope);
    envelope.factRef = factRef;
    envelope.roles.fact.root = factRef.cutRoot;
    const stored = {
      checkpointRoot: root(`checkpoint-root:${this.saves}`),
      envelope,
      receipts: clone(checkpoint.receipts),
    };
    this.rows.set(checkpoint.loopRef, stored);
    return {
      status: 'accepted',
      ...clone(stored),
      factRef,
      writeOccurred: true,
    };
  }

  async resolve(loopRef) {
    return clone(this.rows.get(loopRef)?.envelope.factRef);
  }
}

class FileCheckpointStore extends MemoryCheckpointStore {
  constructor(file) {
    super();
    this.file = file;
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.saves = loaded.saves;
      this.rows = new Map(loaded.rows);
    }
  }

  flush() {
    fs.writeFileSync(
      this.file,
      `${JSON.stringify({ saves: this.saves, rows: [...this.rows] })}\n`,
    );
  }

  async save(checkpoint) {
    const saved = await super.save(checkpoint);
    if (saved.status === 'accepted') this.flush();
    return saved;
  }
}

function adapters({ store = new MemoryCheckpointStore(), source = 'a' } = {}) {
  const explicit = createExplicitCompatibilityAdapters();
  const calls = [];
  return {
    calls,
    store,
    ports: {
      ...explicit,
      checkpointStore: store,
      workProfileBinder: {
        async bind(input) {
          calls.push('bind');
          return {
            roles: input.roles,
            factRef: {
              name: input.factRef.name,
              cutRoot: root(`${source}:bind-cut`),
              revision: 1,
            },
            receipt: stepReceipt(input, 'bind-roles', source),
          };
        },
      },
      episodeRecorder: {
        async resumeOrBegin(input) {
          calls.push('open');
          return {
            binding: {
              id: input.episode.id,
              root: null,
              state: 'open',
            },
            receipt: stepReceipt(input, 'open-episode', source),
          };
        },
        async inspect(binding) {
          return { state: binding.state, externalEffect: 'accepted' };
        },
      },
    },
  };
}

test('begin binds explicit roles, opens one Episode, and checkpoints the running envelope', async () => {
  const fixture = adapters();
  const result = await beginActionLoop(contract, request(), fixture.ports);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, 'begun');
  assert.deepEqual(fixture.calls, ['bind', 'open']);
  assert.equal(result.envelope.state, 'running');
  assert.deepEqual(result.envelope.acceptedSteps, [
    'bind-roles',
    'open-episode',
  ]);
  assert.equal(result.envelope.factRef.revision, 3);
  assert.equal(
    result.envelope.roles.fact.root,
    result.envelope.factRef.cutRoot,
  );
  assert.equal(result.nextStep, 'seal-episode');
});

test('missing explicit Warrant requests a decision before any mutation', async () => {
  const fixture = adapters();
  const value = request({
    warrant: {
      explicit: false,
      binding: {
        id: 'warrant:implicit',
        root: root('implicit'),
        state: 'issued',
      },
    },
  });
  const result = await beginActionLoop(contract, value, fixture.ports);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'decision-required');
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.store.saves, 0);
});

test('stale Atlas and revoked Warrant fail before Work Profile or Episode writes', async () => {
  for (const [value, code] of [
    [
      request({
        atlas: {
          binding: {
            id: 'atlas:xinfa',
            root: root('atlas'),
            state: 'current',
          },
          verification: {
            valid: true,
            atlasRoot: root('other-atlas'),
            diagnostics: [],
          },
        },
      }),
      'stale-atlas',
    ],
    [
      request({
        warrant: {
          explicit: true,
          binding: {
            id: 'warrant:revoked',
            root: root('revoked'),
            state: 'revoked',
          },
        },
      }),
      'warrant-revoked',
    ],
  ]) {
    const fixture = adapters();
    const result = await beginActionLoop(contract, value, fixture.ports);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.deepEqual(fixture.calls, []);
  }
});

test('Episode uncertainty retains the accepted bind prefix for deterministic recovery', async () => {
  const fixture = adapters();
  fixture.ports.episodeRecorder.resumeOrBegin = async () => {
    fixture.calls.push('open');
    throw new Error('transport ended after public Episode request');
  };
  const result = await beginActionLoop(contract, request(), fixture.ports);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'recovery-required');
  assert.equal(result.nextStep, 'open-episode');
  assert.equal(result.checkpoint.ok, true);
  assert.equal(result.checkpoint.envelope.state, 'bound');
  assert.deepEqual(result.checkpoint.envelope.acceptedSteps, ['bind-roles']);
  assert.equal(fixture.store.saves, 1);
});

test('a fresh recovery pass refuses an uncertain Episode effect from the durable bound checkpoint', async () => {
  const fixture = adapters();
  fixture.ports.episodeRecorder.resumeOrBegin = async () => {
    fixture.calls.push('open');
    throw new Error('process boundary after public Episode request');
  };
  const begun = await beginActionLoop(contract, request(), fixture.ports);
  assert.equal(begun.code, 'recovery-required');

  fixture.ports.episodeRecorder.inspect = async () => ({
    state: 'unavailable',
    externalEffect: 'unknown',
  });
  const resumed = await resumeActionLoop(
    contract,
    request().loopRef,
    fixture.ports,
  );
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'external-effect-unknown');
  assert.equal(resumed.nextStep, 'inspect-external-effect');
});

test('same loopRef resumes without reopening roles or Episode', async () => {
  const fixture = adapters();
  const first = await beginActionLoop(contract, request(), fixture.ports);
  const second = await beginActionLoop(contract, request(), fixture.ports);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.code, 'resumed');
  assert.deepEqual(fixture.calls, ['bind', 'open']);
  assert.equal(fixture.store.saves, 2);
  assert.equal(second.nextStep, 'seal-episode');
});

test('resume fails closed when the recorded native binding or Profile root drifts', async () => {
  const fixture = adapters();
  const nativeAuthority = {
    schema: 'kungfu.action-loop.native-authority/v0',
    id: 'native:binding-one',
    root: root('native-authority'),
    state: 'current',
    binding: { path: '/opt/kungfu/binding', root: root('binding') },
    profile: { id: 'kungfu.work-control', root: root('profile') },
  };
  fixture.ports.nativeAuthority = {
    async resolve() {
      return { status: 'resolved', binding: nativeAuthority };
    },
    async observe() {
      return {
        status: 'denied',
        code: 'native-authority-drift',
        message: 'the active native binding or Profile root changed',
        current: {
          ...nativeAuthority,
          root: root('different-native-authority'),
        },
      };
    },
  };

  const begun = await beginActionLoop(
    contract,
    request({ nativeAuthority }),
    fixture.ports,
  );
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.equal(begun.envelope.nativeAuthority.root, nativeAuthority.root);

  const resumed = await resumeActionLoop(
    contract,
    request().loopRef,
    fixture.ports,
  );
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'native-authority-drift');
  assert.equal(resumed.writeOccurred, false);
});

test(
  'Core public adapters open a real Episode and recover the native Fact ref in a fresh process',
  {
    skip: !HAS_NATIVE_BINDING && 'native Core binding is not built',
  },
  async () => {
    const runtime = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-action-loop-'),
    );
    const invoke = (operation, payload) => {
      const child = spawnSync(
        'uv',
        [
          'run',
          '--project',
          path.join(DIR, '..', '..', 'core'),
          '--frozen',
          'python',
          '-m',
          'kungfu.agent.action_loop',
          '--runtime-dir',
          runtime,
          operation,
        ],
        {
          cwd: path.join(DIR, '..', '..', '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONPATH: [
              path.join(DIR, '..', '..', 'core', 'src', 'python'),
              path.join(DIR, '..', '..', 'core', 'build', 'python'),
              process.env.PYTHONPATH,
            ]
              .filter(Boolean)
              .join(path.delimiter),
          },
          input: JSON.stringify(payload),
        },
      );
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const native = createCorePublicAdapters(invoke);
    const ports = { ...createExplicitCompatibilityAdapters(), ...native };
    const value = request({
      factRef: {
        name: 'action-loop/native-begin-resume',
        cutRoot: null,
        revision: 0,
      },
      loopRef: 'action-loop/native-begin-resume',
      episode: {
        id: 'episode:native-begin-resume',
        source: 'action-loop:native-begin-resume-v0',
      },
    });

    const begun = await beginActionLoop(contract, value, ports);
    assert.equal(begun.ok, true, JSON.stringify(begun));
    assert.equal(begun.envelope.state, 'running');
    assert.equal(begun.envelope.factRef.revision, 3);

    const child = spawnSync(
      process.execPath,
      [NATIVE_WORKER, runtime, value.loopRef],
      {
        cwd: path.join(DIR, '..', '..', '..'),
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const resumed = JSON.parse(child.stdout);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.code, 'resumed');
    assert.deepEqual(resumed.envelope, begun.envelope);
    assert.equal(resumed.nextStep, 'seal-episode');
  },
);

test('adapter replacement preserves the coordinator contract', async () => {
  const left = adapters({ source: 'left' });
  const right = adapters({ source: 'right' });
  const leftResult = await beginActionLoop(contract, request(), left.ports);
  const rightResult = await beginActionLoop(contract, request(), right.ports);

  assert.equal(leftResult.code, rightResult.code);
  assert.equal(leftResult.envelope.schema, rightResult.envelope.schema);
  assert.equal(leftResult.envelope.state, rightResult.envelope.state);
  assert.deepEqual(
    leftResult.envelope.acceptedSteps,
    rightResult.envelope.acceptedSteps,
  );
  assert.deepEqual(Object.keys(leftResult.envelope.roles), [
    'pursuit',
    'atlas',
    'warrant',
    'episode',
    'fact',
  ]);
});

test('checkpoint refuses a stale expected-old Fact ref without a write', async () => {
  const fixture = adapters();
  const begun = await beginActionLoop(contract, request(), fixture.ports);
  const stale = clone(begun.envelope);
  stale.factRef.revision -= 1;

  const result = await checkpointActionLoop(
    contract,
    { loopRef: request().loopRef, envelope: stale, receipts: begun.receipts },
    fixture.ports,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale-ref');
  assert.equal(result.writeOccurred, false);
  assert.equal(fixture.store.saves, 2);
});

test('a fresh process resumes from only the durable loop ref', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-loop-resume-'));
  const checkpointFile = path.join(parent, 'checkpoints.json');
  try {
    const store = new FileCheckpointStore(checkpointFile);
    const fixture = adapters({ store });
    const begun = await beginActionLoop(contract, request(), fixture.ports);
    assert.equal(begun.ok, true);

    const child = spawnSync(
      process.execPath,
      [WORKER, checkpointFile, request().loopRef],
      { cwd: path.resolve(DIR, '..', '..', '..'), encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const resumed = JSON.parse(child.stdout);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.code, 'resumed');
    assert.equal(resumed.nextStep, 'seal-episode');
    assert.equal(resumed.envelope.loopId, request().loopId);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('resume refuses drift in Atlas, Warrant, Episode, and Fact observations', async () => {
  for (const [field, value, code] of [
    ['atlas', { current: false }, 'stale-atlas'],
    ['warrant', { state: 'expired' }, 'warrant-expired'],
    ['warrant', { state: 'revoked' }, 'warrant-revoked'],
    [
      'episode',
      { state: 'sealed', externalEffect: 'accepted' },
      'episode-state-mismatch',
    ],
    [
      'episode',
      { state: 'open', externalEffect: 'unknown' },
      'external-effect-unknown',
    ],
  ]) {
    const fixture = adapters();
    const begun = await beginActionLoop(contract, request(), fixture.ports);
    if (field === 'atlas')
      fixture.ports.atlasCompiler.observe = async () => value;
    if (field === 'warrant')
      fixture.ports.warrantResolver.observe = async () => value;
    if (field === 'episode')
      fixture.ports.episodeRecorder.inspect = async () => value;
    const resumed = await resumeActionLoop(
      contract,
      request().loopRef,
      fixture.ports,
    );
    assert.equal(resumed.ok, false);
    assert.equal(resumed.code, code);
    assert.equal(begun.ok, true);
  }
});
