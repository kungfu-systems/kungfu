// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'framework',
  'agent-session',
  'kungfu-agent-session.contract.json',
);
const FIXTURE_ROOT = path.join(
  ROOT,
  'tests',
  'fixtures',
  'agent-session-capsule-contract',
);
const CORE_SCHEMA_PATH = path.join(
  ROOT,
  'framework',
  'agent-session',
  'schemas',
  'agent-session-core.schema.json',
);
const CORE_FIXTURE_PATH = path.join(
  ROOT,
  'framework',
  'agent-session',
  'tests',
  'fixtures',
  'agent-session-core-golden.json',
);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function semanticRoot(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function issue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function validateTopology(value) {
  const issues = [];
  const capsules = list(value.capsules);
  const authoritative = capsules.filter(
    (capsule) =>
      capsule.authorityState === 'authoritative' || capsule.ptyOwner === true,
  );
  if (authoritative.length !== 1) {
    issues.push(
      issue(
        'dual-authoritative-capsule',
        '/capsules',
        'one live SessionAttempt requires exactly one authoritative PTY-owning capsule',
      ),
    );
  }
  for (let index = 0; index < capsules.length; index += 1) {
    const capsule = capsules[index];
    if (capsule.sessionAttemptId !== value.sessionAttemptId) {
      issues.push(
        issue(
          'attempt-identity-mismatch',
          `/capsules/${index}/sessionAttemptId`,
          'every capsule must bind the topology SessionAttempt identity',
        ),
      );
    }
    if (
      capsule.authorityState === 'authoritative' &&
      capsule.capsuleGeneration !== value.activeCapsuleGeneration
    ) {
      issues.push(
        issue(
          'stale-capsule-generation',
          `/capsules/${index}/capsuleGeneration`,
          'the authoritative capsule must bind the active runtime generation',
        ),
      );
    }
  }
  return issues;
}

function validateAction(value) {
  const issues = [];
  const lease = object(value.controllerLease);
  const foreground = object(value.foreground);
  if (
    lease.state !== 'active' ||
    lease.capsuleGeneration !== value.capsuleGeneration
  ) {
    issues.push(
      issue(
        'stale-controller-lease',
        '/controllerLease/capsuleGeneration',
        'input admission requires the active controller lease for the current capsule generation',
      ),
    );
  }
  if (value.sessionStreamEpoch !== value.expectedSessionStreamEpoch) {
    issues.push(
      issue(
        'wrong-session-stream-epoch',
        '/sessionStreamEpoch',
        'input must bind the currently advertised session stream epoch',
      ),
    );
  }
  if (
    value.operation === 'instruct' &&
    value.automatic === true &&
    ['approval-needed', 'unknown'].includes(value.interactionState) &&
    value.admissionDecision === 'written'
  ) {
    issues.push(
      issue(
        'unsafe-modal-instruction',
        '/admissionDecision',
        'automatic semantic instruction must be held in approval-needed or unknown state',
      ),
    );
  }
  if (foreground.state !== 'running' && value.admissionDecision === 'written') {
    issues.push(
      issue(
        'provider-not-running',
        '/foreground/state',
        'input cannot be written after the provider foreground has ended or was lost',
      ),
    );
  }
  return issues;
}

function validateStatus(value) {
  const issues = [];
  const foreground = object(value.foreground);
  if (
    ['ended', 'lost'].includes(foreground.state) &&
    value.inputAdmission !== 'closed'
  ) {
    issues.push(
      issue(
        'shell-fallthrough-risk',
        '/inputAdmission',
        'provider exit must close input admission before text can reach a shell prompt',
      ),
    );
  }
  const output = object(value.output);
  if (
    Number.isInteger(output.earliestSequence) &&
    Number.isInteger(output.nextSequence) &&
    output.earliestSequence > output.nextSequence
  ) {
    issues.push(
      issue(
        'invalid-output-window',
        '/output',
        'the earliest retained sequence cannot exceed the next output sequence',
      ),
    );
  }
  return issues;
}

function validateDeliveryReceipt(value) {
  const issues = [];
  if (value.semanticOutcome !== null || value.workState !== null) {
    issues.push(
      issue(
        'transcript-as-work-proof',
        '/semanticOutcome',
        'terminal delivery cannot be promoted to semantic outcome or work-state proof',
      ),
    );
  }
  if (value.status === 'written' && !Number.isInteger(value.writtenOffset)) {
    issues.push(
      issue(
        'written-offset-missing',
        '/writtenOffset',
        'a written delivery receipt must identify the accepted PTY input offset',
      ),
    );
  }
  if (value.status !== 'written' && value.writtenOffset !== null) {
    issues.push(
      issue(
        'non-written-has-offset',
        '/writtenOffset',
        'held, rejected, duplicate, or unknown delivery cannot claim a new PTY write offset',
      ),
    );
  }
  return issues;
}

function validateInputLedger(value) {
  const issues = [];
  const writtenInputs = new Set();
  for (const receipt of list(value.receipts)) {
    issues.push(...validateDeliveryReceipt(receipt));
    if (receipt.status !== 'written') continue;
    if (writtenInputs.has(receipt.inputId)) {
      issues.push(
        issue(
          'duplicate-input-write',
          '/receipts',
          'one inputId may produce at most one written delivery receipt',
        ),
      );
    }
    writtenInputs.add(receipt.inputId);
  }
  return issues;
}

function validateOutputReadReceipt(value) {
  const issues = [];
  if (
    value.requestedSequence < value.earliestAvailableSequence &&
    value.gap === null
  ) {
    issues.push(
      issue(
        'output-gap-unmarked',
        '/gap',
        'bounded replay loss must return an explicit gap and recovery snapshot',
      ),
    );
  }
  if (
    value.gap !== null &&
    value.snapshotSequence < value.earliestAvailableSequence
  ) {
    issues.push(
      issue(
        'gap-snapshot-stale',
        '/snapshotSequence',
        'gap recovery requires a snapshot at or after the retained output boundary',
      ),
    );
  }
  return issues;
}

export function validateAgentSessionContractValue(target, value) {
  if (target === 'sessionPlan') return [];
  if (target === 'sessionAction') return validateAction(object(value));
  if (target === 'sessionTopology') return validateTopology(object(value));
  if (target === 'sessionStatus') return validateStatus(object(value));
  if (target === 'deliveryReceipt')
    return validateDeliveryReceipt(object(value));
  if (target === 'inputLedger') return validateInputLedger(object(value));
  if (target === 'outputReadReceipt')
    return validateOutputReadReceipt(object(value));
  return [
    issue(
      'unknown-target',
      '/',
      `unknown agent-session contract target: ${String(target)}`,
    ),
  ];
}

function setAtPath(value, pathSegments, next) {
  let target = value;
  for (const segment of pathSegments.slice(0, -1)) target = target[segment];
  target[pathSegments.at(-1)] = next;
}

function applyOperation(value, operation) {
  if (operation.operation === 'set') {
    setAtPath(value, operation.path, structuredClone(operation.value));
    return;
  }
  if (operation.operation === 'append-copy') {
    let target = value;
    for (const segment of operation.path) target = target[segment];
    const copy = structuredClone(target[operation.sourceIndex]);
    for (const mutation of operation.mutations || [])
      setAtPath(copy, mutation.path, structuredClone(mutation.value));
    target.push(copy);
    return;
  }
  throw new Error(`unknown fixture operation: ${String(operation.operation)}`);
}

async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

function schemaErrors(validate, value) {
  if (validate(value)) return [];
  return list(validate.errors).map((error) =>
    issue(
      'schema-invalid',
      error.instancePath || '/',
      error.message || 'schema validation failed',
    ),
  );
}

export async function checkAgentSessionContract(root = ROOT) {
  const contractPath = path.join(root, path.relative(ROOT, CONTRACT_PATH));
  const fixtureRoot = path.join(root, path.relative(ROOT, FIXTURE_ROOT));
  const contract = readJson(contractPath);
  const registry = readJson(
    path.join(
      root,
      'framework',
      'spec',
      'contract',
      'kungfu-contracts.registry.json',
    ),
  );
  if (contract.schema !== 'kungfu.agent-session.contract/v1')
    throw new Error('agent-session contract schema mismatch');
  if (contract.weldedSurface !== 'agent-session-control-plane-contract')
    throw new Error('agent-session welded surface mismatch');
  const registryEntry = list(registry.contracts).find(
    (entry) => entry.surface === 'agent-session',
  );
  if (!registryEntry)
    throw new Error('agent-session contract is not registered in KFD-1');
  if (
    registryEntry.source !==
    'framework/agent-session/kungfu-agent-session.contract.json'
  )
    throw new Error('agent-session registry source mismatch');
  if (contract.dependencies?.runtime?.schema !== 'kungfu.runtime.contract/v1')
    throw new Error('agent-session must bind the canonical runtime contract');
  if (contract.interactionPort?.guiOnlyWrite !== false)
    throw new Error('agent-session writes cannot be GUI-only');
  if (contract.providerProcess?.persistentInteractiveShell !== false)
    throw new Error('agent-session provider cannot use a persistent shell');
  if (contract.recovery?.fakePtyRecovery !== false)
    throw new Error('agent-session cannot claim fake PTY recovery');
  if (
    contract.coreValues?.schemaSource !==
    'framework/agent-session/schemas/agent-session-core.schema.json'
  )
    throw new Error('agent-session core value schema source mismatch');
  const frameIds = list(contract.frameClasses).map((frame) => frame.id);
  for (const required of [
    'volatile-terminal-transport',
    'auditable-control',
    'durable-lifecycle',
    'work-fact',
  ]) {
    if (!frameIds.includes(required))
      throw new Error(`agent-session frame class missing: ${required}`);
  }

  const validCases = readJson(path.join(fixtureRoot, 'valid-cases.json'));
  const invalidCases = readJson(path.join(fixtureRoot, 'invalid-cases.json'));
  const byId = new Map(validCases.map((fixture) => [fixture.id, fixture]));

  let schemaValidation = 'skipped';
  const validators = new Map();
  const Ajv2020 = await loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validateContract = ajv.compile(contract.contractSchema);
    const contractIssues = schemaErrors(validateContract, contract);
    if (contractIssues.length)
      throw new Error(
        `agent-session contract metadata failed schema validation: ${JSON.stringify(contractIssues)}`,
      );
    ajv.addSchema(contract.valueSchemaBundle);
    const coreSchema = readJson(
      path.join(root, path.relative(ROOT, CORE_SCHEMA_PATH)),
    );
    const coreFixture = readJson(
      path.join(root, path.relative(ROOT, CORE_FIXTURE_PATH)),
    );
    ajv.addSchema(coreSchema);
    for (const [definition, value] of [
      ['workRef', coreFixture.workRef],
      [
        'agentConsoleEnvelope',
        {
          ...coreFixture.envelopeBody,
          envelopeRoot: coreFixture.envelopeRoot,
        },
      ],
      ...coreFixture.runtimeProfiles.map((profile) => [
        'runtimeProfile',
        profile,
      ]),
    ]) {
      const validate = ajv.getSchema(`${coreSchema.$id}#/$defs/${definition}`);
      if (!validate || !validate(value))
        throw new Error(
          `agent-session core ${definition} fixture failed schema validation: ${JSON.stringify(validate?.errors ?? [])}`,
        );
    }
    if (
      semanticRoot(coreFixture.workRef) !== coreFixture.workRefRoot ||
      semanticRoot(coreFixture.envelopeBody) !== coreFixture.envelopeRoot
    )
      throw new Error('agent-session core semantic-root golden mismatch');
    for (const target of [
      'sessionPlan',
      'sessionAction',
      'sessionTopology',
      'sessionStatus',
      'deliveryReceipt',
      'inputLedger',
      'outputReadReceipt',
    ]) {
      const validate = ajv.getSchema(
        `${contract.valueSchemaBundle.$id}#/$defs/${target}`,
      );
      if (!validate)
        throw new Error(`agent-session schema target unresolved: ${target}`);
      validators.set(target, validate);
    }
    schemaValidation = 'passed';
  }

  for (const fixture of validCases) {
    const issues = validateAgentSessionContractValue(
      fixture.target,
      fixture.value,
    );
    const validate = validators.get(fixture.target);
    if (validate) issues.push(...schemaErrors(validate, fixture.value));
    if (issues.length)
      throw new Error(
        `valid agent-session fixture failed: ${fixture.id} ${JSON.stringify(issues)}`,
      );
  }

  for (const fixture of invalidCases) {
    const base = byId.get(fixture.base);
    if (!base)
      throw new Error(`invalid fixture has unknown base: ${fixture.base}`);
    const value = structuredClone(base.value);
    for (const operation of fixture.operations)
      applyOperation(value, operation);
    const issues = validateAgentSessionContractValue(base.target, value);
    const validate = validators.get(base.target);
    if (validate) issues.push(...schemaErrors(validate, value));
    if (!issues.some((item) => item.code === fixture.issue)) {
      throw new Error(
        `negative agent-session fixture did not prove ${fixture.issue}: ${fixture.id} ${JSON.stringify(issues)}`,
      );
    }
  }

  return {
    contract: path.relative(root, contractPath).split(path.sep).join('/'),
    validFixtures: validCases.length,
    rejectedFixtures: invalidCases.length,
    schemaValidation,
  };
}
