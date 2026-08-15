// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  KfxServiceWebhookHost,
  validateKfxServiceHostDeclaration,
} from '../sdk/service-webhook-host.mjs';

export const packageIdentity = Object.freeze({
  key: 'github-dogfood-bridge',
  version: '0.1.0',
  productVersion: '4.0.0-alpha.1',
  kitRoot:
    'sha256:819ae3f7ebd4934cadb28ee5b37f346e1feeb8d4fb1de35d290d75c35ed8c62f',
  sdkRoot:
    'sha256:422a4c00c8f42a5aacc0cca8ed80c96ed433bd0e9f56a9ed297f60719264e842',
});

export const DOGFOOD_PROVIDER = 'kungfu.dogfood-feedback';
export const DOGFOOD_VERSION = '4.0.0-alpha.1';
export const FINDING_CAPABILITY = 'dogfood.finding.capture';

export const declaration = Object.freeze({
  schema: 'kungfu.kfx.service-host/v1',
  contractVersion: 1,
  lifecycle: {
    restartPolicy: 'on-failure',
    readinessTimeoutMs: 5_000,
    drainTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
  },
  webhook: {
    listener: {
      mode: 'loopback',
      bindAddress: '127.0.0.1',
      port: 9_912,
      path: '/github/observations',
      methods: ['POST'],
    },
    credentials: [
      {
        handle: 'credential:github/observation-bridge',
        purpose: 'authenticated-normalized-observation-delivery',
        algorithms: ['hmac-sha256'],
      },
    ],
    intake: {
      maxPayloadBytes: 65_536,
      maxQueueDepth: 16,
      maxInflight: 4,
      maxRequestsPerWindow: 60,
      rateWindowMs: 60_000,
      handlerTimeoutMs: 5_000,
      replayWindowMs: 86_400_000,
    },
  },
});

validateKfxServiceHostDeclaration(declaration);

const ROOT_PATTERN = /^sha256:[a-f0-9]{64}$/;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const root = (value) =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

function dependencyCode(authority) {
  const dependency = authority?.dependency;
  if (!dependency || dependency.providerId !== DOGFOOD_PROVIDER) {
    return 'KF_GITHUB_DOGFOOD_DEPENDENCY_MISSING';
  }
  if (
    dependency.version !== DOGFOOD_VERSION ||
    dependency.compatible !== true ||
    !ROOT_PATTERN.test(dependency.kfdRoot ?? '')
  ) {
    return 'KF_GITHUB_DOGFOOD_DEPENDENCY_INCOMPATIBLE';
  }
  if (dependency.installed !== true || dependency.qualified !== true) {
    return 'KF_GITHUB_DOGFOOD_DEPENDENCY_UNQUALIFIED';
  }
  if (authority.revoked === true) {
    return 'KF_GITHUB_DOGFOOD_CAPABILITY_REVOKED';
  }
  if (
    dependency.authorized !== true ||
    !Array.isArray(authority.grantedCapabilities) ||
    !authority.grantedCapabilities.includes(FINDING_CAPABILITY) ||
    !ROOT_PATTERN.test(authority.warrantRoot ?? '') ||
    !ROOT_PATTERN.test(authority.passportRoot ?? '') ||
    !ROOT_PATTERN.test(authority.capabilityGrantRoot ?? '')
  ) {
    return 'KF_GITHUB_DOGFOOD_UNAUTHORIZED';
  }
  return null;
}

function dormant(code, delivery = null) {
  return {
    schema: 'kungfu.github-dogfood-bridge-receipt/v1',
    outcome: 'dormant',
    code,
    delivery,
    effect: null,
  };
}

export class GitHubDogfoodBridge {
  constructor({ authority, capabilityExecutor, captureLedger = new Map() }) {
    if (
      !capabilityExecutor ||
      typeof capabilityExecutor.invoke !== 'function'
    ) {
      throw new TypeError(
        'public capability executor with invoke() is required',
      );
    }
    this.authority = authority;
    this.capabilityExecutor = capabilityExecutor;
    if (
      !captureLedger ||
      typeof captureLedger.has !== 'function' ||
      typeof captureLedger.get !== 'function' ||
      typeof captureLedger.set !== 'function'
    ) {
      throw new TypeError('capture ledger must provide has/get/set');
    }
    this.captured = captureLedger;
  }
  status() {
    const code = dependencyCode(this.authority);
    return {
      schema: 'kungfu.github-dogfood-bridge-status/v1',
      state: code ? 'dormant' : 'available',
      code,
      providerId: this.authority?.dependency?.providerId ?? null,
      dependencyVersion: this.authority?.dependency?.version ?? null,
    };
  }
  updateAuthority(authority) {
    this.authority = authority;
    return this.status();
  }
  async captureObservation(observation) {
    const code = dependencyCode(this.authority);
    if (code) return dormant(code, observation?.delivery ?? null);
    if (
      observation?.schema !== 'kungfu.github-webhook-observation/v1' ||
      observation.outcome !== 'observed' ||
      !ROOT_PATTERN.test(observation.payloadRoot ?? '') ||
      !ROOT_PATTERN.test(observation.object?.contentRoot ?? '')
    ) {
      return dormant(
        'KF_GITHUB_DOGFOOD_OBSERVATION_INVALID',
        observation?.delivery ?? null,
      );
    }
    if (this.captured.has(observation.delivery)) {
      return {
        ...this.captured.get(observation.delivery),
        outcome: 'deduplicated',
        code: 'KF_GITHUB_DOGFOOD_ALREADY_CAPTURED',
      };
    }

    const proposal = {
      schema: 'kungfu.dogfood-finding-capture-proposal/v1',
      operation: 'capture-finding',
      findingId: `github-${createHash('sha256')
        .update(observation.delivery)
        .digest('hex')
        .slice(0, 24)}`,
      source: {
        provider: 'github',
        repository: observation.repository,
        event: observation.event,
        action: observation.action,
        delivery: observation.delivery,
        sender: observation.sender,
        object: observation.object,
        payloadRoot: observation.payloadRoot,
        observedAt: observation.observedAt,
      },
      authority: {
        kfdRoot: this.authority.dependency.kfdRoot,
        warrantRoot: this.authority.warrantRoot,
        passportRoot: this.authority.passportRoot,
        capabilityGrantRoot: this.authority.capabilityGrantRoot,
      },
      limits: {
        immutableFindingOnly: true,
        issueAdmission: false,
        workMutation: false,
        githubMutation: false,
        semanticCompletion: false,
      },
    };
    const proposalRoot = root(proposal);
    const effect = await this.capabilityExecutor.invoke(
      FINDING_CAPABILITY,
      proposal,
    );
    if (
      effect?.kind !== 'finding' ||
      effect.immutable !== true ||
      !ROOT_PATTERN.test(effect.findingRoot ?? '') ||
      effect.issueAdmitted === true ||
      effect.workMutated === true ||
      effect.githubMutated === true ||
      effect.semanticCompletion === true
    ) {
      throw new Error('Dogfood capability returned an invalid Finding effect');
    }
    const receipt = {
      schema: 'kungfu.github-dogfood-bridge-receipt/v1',
      outcome: 'captured',
      code: null,
      delivery: observation.delivery,
      proposalRoot,
      effect: {
        kind: 'finding',
        immutable: true,
        findingRoot: effect.findingRoot,
      },
    };
    this.captured.set(observation.delivery, receipt);
    return receipt;
  }
}

export function createGitHubDogfoodBridgeService({
  evidence,
  credentialBroker,
  bridge,
  clock = Date,
}) {
  if (!(bridge instanceof GitHubDogfoodBridge)) {
    throw new TypeError('GitHubDogfoodBridge is required');
  }
  return new KfxServiceWebhookHost(
    declaration,
    evidence,
    credentialBroker,
    {
      credentialHandle: 'credential:github/observation-bridge',
      algorithm: 'hmac-sha256',
      async normalize(request) {
        const observation = JSON.parse(new TextDecoder().decode(request.body));
        return observation;
      },
      onEvent: (observation) => bridge.captureObservation(observation),
    },
    clock,
  );
}
