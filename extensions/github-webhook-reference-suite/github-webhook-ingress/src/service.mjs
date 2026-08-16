// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  KfxServiceWebhookHost,
  validateKfxServiceHostDeclaration,
} from '../sdk/service-webhook-host.mjs';

export const packageIdentity = Object.freeze({
  key: 'github-webhook-ingress',
  version: '0.1.0',
  productVersion: '4.0.0-alpha.3',
  kitRoot:
    'sha256:819ae3f7ebd4934cadb28ee5b37f346e1feeb8d4fb1de35d290d75c35ed8c62f',
  sdkRoot:
    'sha256:422a4c00c8f42a5aacc0cca8ed80c96ed433bd0e9f56a9ed297f60719264e842',
});

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
      port: 9_911,
      path: '/github/events',
      methods: ['POST'],
    },
    credentials: [
      {
        handle: 'credential:github/webhook',
        purpose: 'github-webhook-signature-verification',
        algorithms: ['hmac-sha256'],
      },
    ],
    intake: {
      maxPayloadBytes: 262_144,
      maxQueueDepth: 32,
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
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const EVENT_ACTIONS = Object.freeze({
  issues: new Set(['opened', 'edited', 'closed', 'reopened']),
  issue_comment: new Set(['created', 'edited', 'deleted']),
});

const contentRoot = (value) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

function header(headers, name) {
  const wanted = name.toLowerCase();
  const pair = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return pair ? String(pair[1] ?? '') : '';
}

function noOp(code, delivery, event, details = {}) {
  return {
    schema: 'kungfu.github-webhook-observation/v1',
    outcome: 'no-op',
    code,
    delivery: delivery || null,
    event: event || null,
    ...details,
  };
}

export class MemoryDeliveryStore {
  constructor({ maxEntries = 4_096, ttlMs = 604_800_000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || ttlMs < 1) {
      throw new TypeError('delivery store bounds must be positive');
    }
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }
  admit(delivery, observedAt) {
    for (const [key, timestamp] of this.entries) {
      if (timestamp <= observedAt - this.ttlMs) this.entries.delete(key);
    }
    if (this.entries.has(delivery)) return false;
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(delivery, observedAt);
    return true;
  }
}

function eventTimestamp(eventName, payload) {
  const object =
    eventName === 'issue_comment' ? payload.comment : payload.issue;
  return object?.updated_at ?? object?.created_at ?? null;
}

export function normalizeGitHubEvent(
  request,
  { repositories, deliveryStore, maxEventAgeMs = 604_800_000, clock = Date },
) {
  const delivery = header(request.headers, 'x-github-delivery');
  const event = header(request.headers, 'x-github-event');
  if (!DELIVERY_PATTERN.test(delivery)) {
    return noOp('KF_GITHUB_DELIVERY_INVALID', delivery, event);
  }
  if (!deliveryStore.admit(delivery, clock.now())) {
    return noOp('KF_GITHUB_DELIVERY_DUPLICATE', delivery, event);
  }
  if (!Object.hasOwn(EVENT_ACTIONS, event)) {
    return noOp('KF_GITHUB_EVENT_DISALLOWED', delivery, event);
  }
  const contentType = header(request.headers, 'content-type').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return noOp('KF_GITHUB_CONTENT_UNSUPPORTED', delivery, event);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return noOp('KF_GITHUB_CONTENT_UNSUPPORTED', delivery, event);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return noOp('KF_GITHUB_CONTENT_UNSUPPORTED', delivery, event);
  }

  const repository = String(payload.repository?.full_name ?? '');
  if (!repositories.has(repository)) {
    return noOp('KF_GITHUB_REPOSITORY_DISALLOWED', delivery, event, {
      repository: repository || null,
    });
  }
  const action = String(payload.action ?? '');
  if (!EVENT_ACTIONS[event].has(action)) {
    return noOp('KF_GITHUB_ACTION_DISALLOWED', delivery, event, {
      repository,
      action: action || null,
    });
  }

  const timestamp = eventTimestamp(event, payload);
  const observedAt = Date.parse(String(timestamp ?? ''));
  const age = clock.now() - observedAt;
  if (!Number.isFinite(observedAt) || age > maxEventAgeMs || age < -300_000) {
    return noOp('KF_GITHUB_TIMESTAMP_STALE', delivery, event, {
      repository,
      action,
    });
  }

  const issue = payload.issue;
  const comment = payload.comment;
  if (!issue || !Number.isInteger(issue.number)) {
    return noOp('KF_GITHUB_CONTENT_UNSUPPORTED', delivery, event, {
      repository,
      action,
    });
  }
  const object = event === 'issue_comment' ? comment : issue;
  if (!object || typeof object !== 'object') {
    return noOp('KF_GITHUB_CONTENT_UNSUPPORTED', delivery, event, {
      repository,
      action,
    });
  }

  const body = String(object.body ?? '');
  const title = String(issue.title ?? '');
  return {
    schema: 'kungfu.github-webhook-observation/v1',
    outcome: 'observed',
    code: null,
    provider: 'github',
    delivery,
    event,
    action,
    repository,
    sender: String(payload.sender?.login ?? 'unknown'),
    object: {
      kind: event === 'issue_comment' ? 'issue-comment' : 'issue',
      id: String(object.id ?? ''),
      issueNumber: issue.number,
      url: String(object.html_url ?? issue.html_url ?? ''),
      title: title.slice(0, 256),
      excerpt: body.slice(0, 512),
      contentRoot: contentRoot(Buffer.from(`${title}\n${body}`, 'utf8')),
    },
    payloadRoot: contentRoot(request.body),
    observedAt: new Date(observedAt).toISOString(),
  };
}

export class BoundedEventQueue {
  constructor({ maxDepth = 32, process, onEvidence = () => {} }) {
    if (
      !Number.isInteger(maxDepth) ||
      maxDepth < 1 ||
      typeof process !== 'function'
    ) {
      throw new TypeError('bounded queue requires maxDepth and process(event)');
    }
    this.maxDepth = maxDepth;
    this.process = process;
    this.onEvidence = onEvidence;
    this.pending = [];
    this.active = false;
    this.waiters = [];
  }
  enqueue(event) {
    const depth = this.pending.length + (this.active ? 1 : 0);
    if (depth >= this.maxDepth) {
      const evidence = {
        schema: 'kungfu.github-webhook-processing/v1',
        outcome: 'no-op',
        code: 'KF_GITHUB_QUEUE_FULL',
        delivery: event.delivery ?? null,
      };
      this.onEvidence(evidence);
      return evidence;
    }
    this.pending.push(event);
    queueMicrotask(() => void this.drain());
    return {
      schema: 'kungfu.github-webhook-processing/v1',
      outcome: 'queued',
      code: null,
      delivery: event.delivery ?? null,
    };
  }
  async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending.length > 0) {
        const event = this.pending.shift();
        try {
          if (event.outcome === 'observed') await this.process(event);
          this.onEvidence({
            schema: 'kungfu.github-webhook-processing/v1',
            outcome: event.outcome === 'observed' ? 'applied' : 'no-op',
            code: event.code,
            delivery: event.delivery ?? null,
          });
        } catch {
          this.onEvidence({
            schema: 'kungfu.github-webhook-processing/v1',
            outcome: 'failed',
            code: 'KF_GITHUB_PROCESSING_FAILED',
            delivery: event.delivery ?? null,
          });
        }
      }
    } finally {
      this.active = false;
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }
  flush() {
    if (!this.active && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createGitHubWebhookService({
  evidence,
  credentialBroker,
  repositories,
  processEvent,
  onEvidence = () => {},
  clock = Date,
  queueDepth = 32,
  deliveryStore = new MemoryDeliveryStore(),
}) {
  if (!credentialBroker || typeof credentialBroker.verify !== 'function') {
    throw new TypeError('credential broker with verify(request) is required');
  }
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new TypeError(
      'an explicit non-empty repository allowlist is required',
    );
  }
  if (!deliveryStore || typeof deliveryStore.admit !== 'function') {
    throw new TypeError(
      'delivery store with admit(delivery, observedAt) is required',
    );
  }
  const repositorySet = new Set(repositories);
  const queue = new BoundedEventQueue({
    maxDepth: queueDepth,
    process: processEvent,
    onEvidence,
  });
  const host = new KfxServiceWebhookHost(
    declaration,
    evidence,
    credentialBroker,
    {
      credentialHandle: 'credential:github/webhook',
      algorithm: 'hmac-sha256',
      normalize: (request) =>
        normalizeGitHubEvent(request, {
          repositories: repositorySet,
          deliveryStore,
          clock,
        }),
      onEvent: async (event) => queue.enqueue(event),
    },
    clock,
  );
  return { host, queue, deliveryStore };
}

export function isContentRoot(value) {
  return ROOT_PATTERN.test(value);
}
