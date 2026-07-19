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
  createCorePublicAdapters,
  createExplicitCompatibilityAdapters,
} from './action-loop-begin.mjs';
import {
  createSettlementCoreAdapters,
  settleActionLoop,
} from './action-loop-settle.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, 'action-loop.contract.json'), 'utf8'),
);
const NATIVE_BINDING_DIR = path.join(DIR, '..', 'core', 'build', 'python');
const NATIVE_WORKER = path.join(
  DIR,
  'fixtures',
  'action-loop-native-resume-worker.mjs',
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function receipt(input, stepId, source) {
  return {
    schema: 'kungfu.action-loop.step-receipt/v0',
    loopId: input.loopId,
    stepId,
    idempotencyKey: input.idempotencyKey,
    receiptRoot: root(`${source}:${stepId}`),
    status: 'accepted',
    preconditionRoots: [input.loopRoot],
    resultRoots: [root(`${source}:${stepId}:result`)],
  };
}

function beginRequest() {
  return {
    schema: 'kungfu.action-loop.begin-request/v0',
    loopId: 'loop:settlement',
    loopRoot: root('loop:settlement'),
    loopRef: 'action-loop/settlement',
    idempotencyKey: 'settlement-v0',
    factRef: { name: 'action-loop/settlement', cutRoot: null, revision: 0 },
    pursuit: {
      explicit: true,
      binding: {
        id: 'pursuit:settlement',
        root: root('pursuit'),
        state: 'active',
      },
    },
    atlas: {
      binding: {
        id: 'atlas:predecessor',
        root: root('atlas:old'),
        state: 'current',
      },
      verification: {
        valid: true,
        atlasRoot: root('atlas:old'),
        diagnostics: [],
      },
    },
    warrant: {
      explicit: true,
      binding: {
        id: 'warrant:settlement',
        root: root('warrant'),
        state: 'issued',
      },
    },
    episode: { id: 'episode:settlement', source: 'action-loop:settlement' },
    fact: { id: 'fact:settlement', root: root('fact'), state: 'declared' },
  };
}

function settlementRequest(overrides = {}) {
  return {
    loopRef: 'action-loop/settlement',
    result: { reason: 'fixture complete' },
    successorAtlas: {
      binding: {
        id: 'atlas:successor',
        root: root('atlas:new'),
        state: 'current',
      },
      verification: {
        valid: true,
        atlasRoot: root('atlas:new'),
        receiptRoot: root('atlas:verification'),
        diagnostics: [],
      },
    },
    completion: { statement: 'fixture complete' },
    settlement: { settlementRoot: root('settlement'), outcome: 'completed' },
    ...overrides,
  };
}

class CheckpointStore {
  constructor() {
    this.current = null;
    this.revision = 0;
  }

  async load() {
    return this.current
      ? { status: 'current', ...clone(this.current) }
      : { status: 'absent' };
  }

  async save(value) {
    if (
      this.current &&
      this.current.envelope.factRef.cutRoot !== value.expectedOld.cutRoot
    ) {
      return { status: 'denied', code: 'stale-ref', writeOccurred: false };
    }
    this.revision += 1;
    const factRef = {
      name: value.expectedOld.name,
      cutRoot: root(`checkpoint:${this.revision}`),
      revision: this.revision,
    };
    const envelope = clone(value.envelope);
    envelope.factRef = factRef;
    envelope.roles.fact.root = factRef.cutRoot;
    this.current = {
      checkpointRoot: root(`checkpoint-root:${this.revision}`),
      envelope,
      receipts: clone(value.receipts),
    };
    return {
      status: 'accepted',
      ...clone(this.current),
      factRef,
      writeOccurred: true,
    };
  }

  async resolve() {
    return clone(this.current?.envelope.factRef);
  }

  settle(input, stepReceipt) {
    this.revision += 1;
    const envelope = clone(input.envelope);
    const factRef = {
      name: envelope.factRef.name,
      cutRoot: root(`settled:${this.revision}`),
      revision: this.revision,
    };
    envelope.state = 'settled';
    envelope.acceptedSteps.push('settle-fact-ref');
    envelope.factRef = factRef;
    envelope.roles.fact = {
      ...envelope.roles.fact,
      root: factRef.cutRoot,
      state: 'superseded',
    };
    envelope.roles.pursuit = { ...envelope.roles.pursuit, state: 'completed' };
    envelope.roles.warrant = { ...envelope.roles.warrant, state: 'expired' };
    this.current = {
      checkpointRoot: root(`checkpoint-root:${this.revision}`),
      envelope,
      receipts: [...clone(input.receipts), clone(stepReceipt)],
    };
    return clone(this.current);
  }
}

function adapters({
  reviewVerdict = 'fit',
  failSeal = false,
  staleFinal = false,
} = {}) {
  const explicit = createExplicitCompatibilityAdapters();
  const store = new CheckpointStore();
  let currentReviewVerdict = reviewVerdict;
  const ports = {
    ...explicit,
    checkpointStore: store,
    workProfileBinder: {
      async bind(input) {
        return {
          roles: input.roles,
          factRef: {
            name: input.factRef.name,
            cutRoot: root('bound'),
            revision: 1,
          },
          receipt: receipt(input, 'bind-roles', 'begin'),
        };
      },
    },
    episodeRecorder: {
      async resumeOrBegin(input) {
        return {
          binding: { id: input.episode.id, root: null, state: 'open' },
          receipt: receipt(input, 'open-episode', 'begin'),
        };
      },
      async inspect(binding) {
        return { state: binding.state, externalEffect: 'accepted' };
      },
      async seal(input) {
        if (failSeal) throw new Error('connection lost after close');
        return {
          status: 'accepted',
          binding: {
            ...input.episode,
            root: root('episode:sealed'),
            state: 'sealed',
          },
          receipt: receipt(input, 'seal-episode', 'settle'),
        };
      },
    },
    atlasRefresher: {
      async refresh(input) {
        return {
          status: 'accepted',
          binding: input.successor.binding,
          receipt: receipt(input, 'refresh-atlas', 'settle'),
        };
      },
    },
    completionReviewer: {
      async review(input) {
        if (currentReviewVerdict !== 'fit') {
          return {
            status: 'pending',
            verdict: currentReviewVerdict,
            evidenceRequests: ['sealed evidence'],
          };
        }
        return {
          status: 'accepted',
          verdict: 'fit',
          completionClaimRoot: root('claim'),
          independentReviewRoot: root('review'),
          continuationPlanRoot: root('continuation'),
          receipt: receipt(input, 'review-completion', 'settle'),
        };
      },
    },
    factCommitter: {
      async settle(input) {
        if (staleFinal) {
          return {
            status: 'denied',
            code: 'stale-ref',
            message: 'expected-old changed',
            writeOccurred: false,
          };
        }
        const stepReceipt = receipt(input, 'settle-fact-ref', 'settle');
        const saved = store.settle(input, stepReceipt);
        return {
          status: 'accepted',
          ...saved,
          receipt: stepReceipt,
          writeOccurred: true,
        };
      },
    },
  };
  return {
    ports,
    store,
    setReviewVerdict(value) {
      currentReviewVerdict = value;
    },
  };
}

async function begunPorts(options) {
  const fixture = adapters(options);
  const begun = await beginActionLoop(contract, beginRequest(), fixture.ports);
  assert.equal(begun.ok, true);
  assert.equal(begun.envelope.state, 'running');
  return fixture;
}

test('settlement closes every ordered step and is idempotent', async () => {
  const fixture = await begunPorts();
  const settled = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(settled.ok, true);
  assert.equal(settled.code, 'settled');
  assert.equal(settled.envelope.state, 'settled');
  assert.equal(settled.envelope.roles.episode.state, 'sealed');
  assert.equal(settled.envelope.roles.pursuit.state, 'completed');
  assert.equal(settled.envelope.roles.warrant.state, 'expired');
  assert.deepEqual(
    settled.envelope.acceptedSteps,
    contract.orderedSteps.map(({ id }) => id),
  );

  const repeated = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.code, 'already-settled');
  assert.equal(repeated.writeOccurred, false);
});

test('unknown Episode outcome fails closed at the durable running checkpoint', async () => {
  const fixture = await begunPorts({ failSeal: true });
  const failed = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'external-effect-unknown');
  assert.equal(failed.nextStep, 'inspect-external-effect');
  assert.equal((await fixture.store.load()).envelope.state, 'running');
});

test('pending review resumes without repeating sealed and Atlas steps', async () => {
  const fixture = await begunPorts({ reviewVerdict: 'pending' });
  const pending = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'review-pending');
  assert.equal((await fixture.store.load()).envelope.state, 'atlas-refreshed');

  fixture.setReviewVerdict('fit');
  const settled = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(settled.ok, true);
  assert.equal(settled.envelope.state, 'settled');
});

test('stale final Fact CAS writes no settlement checkpoint', async () => {
  const fixture = await begunPorts({ staleFinal: true });
  const failed = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'stale-ref');
  assert.equal(failed.writeOccurred, false);
  assert.equal((await fixture.store.load()).envelope.state, 'reviewed');
});

test(
  'Core adapters seal a real Episode and persist final Fact settlement across processes',
  { skip: !HAS_NATIVE_BINDING && 'native Core binding is not built' },
  async () => {
    const runtime = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-action-loop-settle-'),
    );
    const invoke = (operation, payload) => {
      const child = spawnSync(
        'uv',
        [
          'run',
          '--project',
          path.join(DIR, '..', 'core'),
          '--frozen',
          'python',
          '-m',
          'kungfu.agent.action_loop',
          '--runtime-dir',
          runtime,
          operation,
        ],
        {
          cwd: path.join(DIR, '..', '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONPATH: [
              NATIVE_BINDING_DIR,
              path.join(DIR, '..', 'core', 'src', 'python'),
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
    const beginCore = createCorePublicAdapters(invoke);
    const settleCore = createSettlementCoreAdapters(invoke);
    const explicit = createExplicitCompatibilityAdapters();
    let injectFinalRefDrift = true;
    const ports = {
      ...explicit,
      ...beginCore,
      ...settleCore,
      episodeRecorder: {
        ...beginCore.episodeRecorder,
        ...settleCore.episodeRecorder,
      },
      completionReviewer: {
        async review(input) {
          return {
            status: 'accepted',
            verdict: 'fit',
            completionClaimRoot: root('native:claim'),
            independentReviewRoot: root('native:review'),
            continuationPlanRoot: root('native:continuation'),
            receipt: receipt(input, 'review-completion', 'native'),
          };
        },
      },
      factCommitter: {
        async settle(input) {
          if (injectFinalRefDrift) {
            injectFinalRefDrift = false;
            const driftEnvelope = clone(input.envelope);
            driftEnvelope.residualRisk = [
              ...driftEnvelope.residualRisk,
              'injected final ref drift',
            ];
            const drifted = invoke('checkpoint-save', {
              schema: 'kungfu.action-loop.checkpoint/v0',
              loopRef: input.loopRef,
              expectedOld: input.envelope.factRef,
              envelope: driftEnvelope,
              receipts: input.receipts,
            });
            assert.equal(drifted.status, 'accepted', JSON.stringify(drifted));
            assert.notEqual(
              drifted.factRef.cutRoot,
              input.envelope.factRef.cutRoot,
            );
          }
          return settleCore.factCommitter.settle(input);
        },
      },
    };
    const begin = beginRequest();
    begin.loopId = 'loop:native-settlement';
    begin.loopRoot = root('loop:native-settlement');
    begin.loopRef = 'action-loop/native-settlement';
    begin.factRef.name = begin.loopRef;
    begin.episode = {
      id: 'episode:native-settlement',
      source: 'action-loop:native-settlement',
    };
    const begun = await beginActionLoop(contract, begin, ports);
    assert.equal(begun.ok, true, JSON.stringify(begun));

    const request = settlementRequest({ loopRef: begin.loopRef });
    const stale = await settleActionLoop(contract, request, ports);
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(stale.code, 'stale-ref');
    assert.equal(stale.writeOccurred, false);

    const settled = await settleActionLoop(contract, request, ports);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.envelope.state, 'settled');
    assert.equal(settled.envelope.roles.episode.state, 'sealed');
    assert.equal(settled.envelope.roles.pursuit.state, 'completed');
    assert.equal(settled.envelope.roles.warrant.state, 'expired');

    const child = spawnSync(
      process.execPath,
      [NATIVE_WORKER, runtime, begin.loopRef],
      {
        cwd: path.join(DIR, '..', '..'),
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const resumed = JSON.parse(child.stdout);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.code, 'already-settled');
    assert.equal(resumed.envelope.state, 'settled');
  },
);
