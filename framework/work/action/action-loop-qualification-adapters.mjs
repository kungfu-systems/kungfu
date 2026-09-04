// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';

import {
  beginActionLoop,
  createCorePublicAdapters,
  createExplicitCompatibilityAdapters,
} from './action-loop-begin.mjs';
import {
  createSettlementCoreAdapters,
  settleActionLoop,
} from './action-loop-settle.mjs';
import { rootStepReceipt } from './action-loop.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const root = (value) =>
  `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

function adapterReceipt(input, stepId, authority, result) {
  return rootStepReceipt({
    schema: 'kungfu.action-loop.step-receipt/v0',
    loopId: input.loopId,
    stepId,
    idempotencyKey: input.idempotencyKey,
    status: 'accepted',
    preconditionRoots: [input.loopRoot],
    resultRoots: [root(result)],
    authorityReceiptRoot: root({
      adapter: 'qualification-public-port',
      authority,
      input,
      result,
      stepId,
    }),
  });
}

class QualificationCheckpointStore {
  constructor() {
    this.current = null;
    this.history = [];
    this.revision = 0;
  }

  async load() {
    return this.current
      ? { status: 'current', ...clone(this.current) }
      : { status: 'absent' };
  }

  async save(value) {
    this.revision += 1;
    const factRef = {
      name: value.expectedOld.name,
      cutRoot: root(`qualification-checkpoint:${this.revision}`),
      revision: this.revision,
    };
    const envelope = clone(value.envelope);
    envelope.factRef = factRef;
    envelope.roles.fact.root = factRef.cutRoot;
    this.current = {
      checkpointRoot: root(`qualification-checkpoint-root:${this.revision}`),
      envelope,
      receipts: clone(value.receipts),
    };
    this.history.push(clone(this.current));
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

  settle(input, receipt) {
    this.revision += 1;
    const factRef = {
      name: input.envelope.factRef.name,
      cutRoot: root(`qualification-settled:${this.revision}`),
      revision: this.revision,
    };
    const envelope = clone(input.envelope);
    envelope.state = 'settled';
    envelope.acceptedSteps.push('settle-fact-ref');
    envelope.factRef = factRef;
    envelope.roles.fact = {
      ...envelope.roles.fact,
      root: factRef.cutRoot,
      state: 'superseded',
    };
    envelope.roles.pursuit.state = 'completed';
    envelope.roles.warrant.state = 'expired';
    this.current = {
      checkpointRoot: root(`qualification-checkpoint-root:${this.revision}`),
      envelope,
      receipts: [...clone(input.receipts), clone(receipt)],
    };
    this.history.push(clone(this.current));
    return clone(this.current);
  }
}

function request() {
  return {
    schema: 'kungfu.action-loop.begin-request/v0',
    loopId: 'loop:work-profile-conformance',
    loopRoot: root('qualification-loop'),
    loopRef: 'action-loop/work-profile-conformance',
    idempotencyKey: 'work-profile-conformance-v1',
    factRef: {
      name: 'action-loop/work-profile-conformance',
      cutRoot: null,
      revision: 0,
    },
    pursuit: {
      explicit: true,
      binding: {
        id: 'pursuit:qualification',
        root: root('qualification-pursuit'),
        state: 'active',
      },
    },
    atlas: {
      binding: {
        id: 'atlas:qualification',
        root: root('qualification-atlas-old'),
        state: 'current',
      },
      verification: {
        valid: true,
        atlasRoot: root('qualification-atlas-old'),
        diagnostics: [],
      },
    },
    warrant: {
      explicit: true,
      binding: {
        id: 'warrant:qualification',
        root: root('qualification-warrant'),
        state: 'issued',
      },
    },
    episode: {
      id: 'episode:qualification',
      source: 'action-loop:work-profile-conformance',
    },
    fact: {
      id: 'fact:qualification',
      root: root('qualification-fact'),
      state: 'declared',
    },
  };
}

function settlementRequest() {
  const atlasRoot = root('qualification-atlas-new');
  return {
    loopRef: 'action-loop/work-profile-conformance',
    result: { reason: 'qualification fixture complete' },
    successorAtlas: {
      binding: {
        id: 'atlas:qualification-next',
        root: atlasRoot,
        state: 'current',
      },
      verification: {
        valid: true,
        atlasRoot,
        receiptRoot: root('qualification-atlas-verification'),
        diagnostics: [],
      },
    },
    completion: { statement: 'qualification fixture complete' },
    settlement: {
      settlementRoot: root('qualification-settlement'),
      outcome: 'completed',
    },
  };
}

function adapters({ forgeBindReceipt = false } = {}) {
  const store = new QualificationCheckpointStore();
  async function invoke(operation, input) {
    switch (operation) {
      case 'authority-inspect':
        return { status: 'current', ...clone(input) };
      case 'work-profile-bind': {
        const result = {
          roles: input.roles,
          factRef: {
            name: input.factRef.name,
            cutRoot: root({ operation, input }),
            revision: 1,
          },
        };
        const receipt = adapterReceipt(input, 'bind-roles', operation, result);
        if (forgeBindReceipt)
          receipt.receiptRoot = root('forged-by-coordinator');
        return { ...result, receipt };
      }
      case 'episode-resume-or-begin': {
        const result = {
          binding: { id: input.episode.id, root: null, state: 'open' },
        };
        return {
          ...result,
          receipt: adapterReceipt(input, 'open-episode', operation, result),
        };
      }
      case 'episode-inspect':
        return { state: input.state, externalEffect: 'accepted' };
      case 'checkpoint-load':
        return store.load(input);
      case 'checkpoint-save':
        return store.save(input);
      case 'checkpoint-resolve':
        return store.resolve(input);
      case 'episode-seal': {
        const result = {
          status: 'accepted',
          binding: {
            ...input.episode,
            root: root({ operation, episode: input.episode }),
            state: 'sealed',
          },
        };
        return {
          ...result,
          receipt: adapterReceipt(input, 'seal-episode', operation, result),
        };
      }
      case 'work-profile-atlas-refresh': {
        const result = { status: 'accepted', binding: input.successor.binding };
        return {
          ...result,
          receipt: adapterReceipt(input, 'refresh-atlas', operation, result),
        };
      }
      case 'completion-review': {
        const result = {
          status: 'accepted',
          verdict: 'fit',
          completionClaimRoot: root({ operation, input, kind: 'claim' }),
          independentReviewRoot: root({ operation, input, kind: 'review' }),
          continuationPlanRoot: root({
            operation,
            input,
            kind: 'continuation',
          }),
        };
        return {
          ...result,
          receipt: adapterReceipt(
            input,
            'review-completion',
            operation,
            result,
          ),
        };
      }
      case 'fact-settle': {
        const preview = { status: 'accepted', writeOccurred: true };
        const receipt = adapterReceipt(
          input,
          'settle-fact-ref',
          operation,
          preview,
        );
        return {
          ...preview,
          ...store.settle(input, receipt),
          receipt,
        };
      }
      default:
        throw new Error(
          `unsupported qualification public operation: ${operation}`,
        );
    }
  }
  const beginPorts = createCorePublicAdapters(invoke);
  const settlementPorts = createSettlementCoreAdapters(invoke);
  const ports = {
    ...createExplicitCompatibilityAdapters(),
    ...beginPorts,
    ...settlementPorts,
    episodeRecorder: {
      ...beginPorts.episodeRecorder,
      ...settlementPorts.episodeRecorder,
    },
  };
  return { ports, store };
}

export async function executeQualificationActionLoop(contract) {
  const fixture = adapters();
  const begun = await beginActionLoop(contract, request(), fixture.ports);
  if (!begun.ok) throw new Error(`qualification begin failed: ${begun.code}`);
  const bound = fixture.store.history.find(
    ({ envelope }) => envelope.state === 'bound',
  );
  const running = clone(fixture.store.current);
  const settled = await settleActionLoop(
    contract,
    settlementRequest(),
    fixture.ports,
  );
  if (!settled.ok)
    throw new Error(`qualification settlement failed: ${settled.code}`);

  const forged = adapters({ forgeBindReceipt: true });
  const forgedResult = await beginActionLoop(contract, request(), forged.ports);
  if (forgedResult.ok || forgedResult.code !== 'invalid-adapter-receipt')
    throw new Error('forged public adapter receiptRoot was not refused');

  return {
    bound,
    running,
    settled: {
      envelope: settled.envelope,
      receipts: settled.receipts,
      checkpointRoot: settled.checkpointRoot,
    },
    adapterNegative: {
      schema: 'kungfu.action-loop.adapter-negative-witness/v0',
      case: 'forged-receipt-root',
      status: 'passed',
      expectedCode: 'invalid-adapter-receipt',
      actualCode: forgedResult.code,
      writeOccurred: forgedResult.writeOccurred === true,
    },
  };
}
