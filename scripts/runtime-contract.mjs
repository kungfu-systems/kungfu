// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'framework',
  'runtime',
  'kungfu-runtime.contract.json',
);
const FIXTURE_ROOT = path.join(
  ROOT,
  'tests',
  'fixtures',
  'runtime-contract-topology-neutral',
);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function issue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function subsetIssues(values, allowed, code, pathValue) {
  const allowedSet = new Set(list(allowed));
  return list(values)
    .filter((value) => !allowedSet.has(value))
    .map((value) =>
      issue(code, pathValue, `${String(value)} was not requested or granted`),
    );
}

function validateRequirement(value, contract) {
  const issues = [];
  const operationClass = value.operationClass;
  const capabilities = list(value.requiredCapabilities);
  if (operationClass === 'storage-only' && capabilities.length) {
    issues.push(
      issue(
        'storage-only-live-capability',
        '/requiredCapabilities',
        'storage-only operations cannot request live activation capabilities',
      ),
    );
  }
  if (operationClass === 'live-required' && value.allowDegraded === true) {
    issues.push(
      issue(
        'live-required-allows-degraded',
        '/allowDegraded',
        'live-required operations must fail closed',
      ),
    );
  }
  const knownCapabilities = list(contract.capabilities).map((item) => item.id);
  issues.push(
    ...subsetIssues(
      capabilities,
      knownCapabilities,
      'unsupported-capability',
      '/requiredCapabilities',
    ),
  );
  const grants = object(contract.authorities.activation).grants;
  issues.push(
    ...subsetIssues(
      value.requestedAuthorities,
      grants,
      'unknown-authority',
      '/requestedAuthorities',
    ),
  );
  return issues;
}

function validateReadiness(value, prefix = '') {
  const issues = [];
  if (value.state === 'ready' && !value.durableCut) {
    issues.push(
      issue(
        'readiness-cut-missing',
        `${prefix}/durableCut`,
        'ready requires a verified durable cut',
      ),
    );
  }
  if (
    list(value.evidence).some((item) => object(item).kind === 'process-pid')
  ) {
    issues.push(
      issue(
        'pid-is-not-readiness',
        `${prefix}/evidence`,
        'process pid evidence is diagnostic only',
      ),
    );
  }
  return issues;
}

function validateHandle(value, contract, prefix = '') {
  const issues = [];
  const readiness = object(value.readiness);
  const diagnostics = object(object(value.host).diagnostics);
  const ready = value.state === 'ready' || readiness.state === 'ready';
  issues.push(...validateReadiness(readiness, `${prefix}/readiness`));
  if (value.state !== readiness.state) {
    issues.push(
      issue(
        'readiness-state-mismatch',
        `${prefix}/readiness/state`,
        'handle and readiness states must match',
      ),
    );
  }
  if (ready && !readiness.durableCut) {
    if (
      Number.isInteger(diagnostics.supervisorPid) ||
      Number.isInteger(diagnostics.coordinatorPid)
    ) {
      issues.push(
        issue(
          'pid-is-not-readiness',
          `${prefix}/host/diagnostics`,
          'a live process cannot replace durable-cut readiness evidence',
        ),
      );
    }
  }
  if (
    ready &&
    list(value.capabilities).includes('runtime.live-projection') &&
    !readiness.projectionCut
  ) {
    issues.push(
      issue(
        'projection-cut-missing',
        `${prefix}/readiness/projectionCut`,
        'runtime.live-projection requires an explicit projection cut',
      ),
    );
  }
  if (
    list(contract.stateMachine.authorityBearingStates).includes(value.state) &&
    value.generation === '0'
  ) {
    issues.push(
      issue(
        'invalid-generation',
        `${prefix}/generation`,
        'authority-bearing handles require a non-zero generation',
      ),
    );
  }
  const currentHostKinds = list(object(contract.hostKinds).currentTopology).map(
    (item) => item.id,
  );
  if (!currentHostKinds.includes(object(value.host).kind)) {
    issues.push(
      issue(
        'unsupported-host-kind',
        `${prefix}/host/kind`,
        'the host kind is not a declared current topology in this contract version',
      ),
    );
  }
  issues.push(
    ...subsetIssues(
      value.grantedAuthorities,
      object(contract.authorities.activation).grants,
      'authority-broadening',
      `${prefix}/grantedAuthorities`,
    ),
  );
  return issues;
}

function validateReceipt(value, contract) {
  const issues = [];
  const requirement = object(value.requirement);
  const required = list(requirement.requiredCapabilities);
  const achieved = list(value.achievedCapabilities);
  const missing = list(value.missingCapabilities);
  const successful = ['activated', 'reused'].includes(value.outcome);
  issues.push(...validateRequirement(requirement, contract));
  if (value.requestId !== requirement.requestId) {
    issues.push(
      issue(
        'request-id-mismatch',
        '/requestId',
        'receipt and requirement request ids must match',
      ),
    );
  }
  if (value.activatedBy !== 'core-broker') {
    issues.push(
      issue(
        'activation-authority-invalid',
        '/activatedBy',
        'CLI, GUI, language bindings, and KFX are request sources, not activation authorities',
      ),
    );
  }
  issues.push(
    ...subsetIssues(
      value.grantedAuthorities,
      requirement.requestedAuthorities,
      'authority-broadening',
      '/grantedAuthorities',
    ),
  );
  if (value.handle) {
    issues.push(...validateHandle(object(value.handle), contract, '/handle'));
    if (value.handle.requirementId !== requirement.requestId) {
      issues.push(
        issue(
          'handle-requirement-mismatch',
          '/handle/requirementId',
          'handle must bind the exact requirement',
        ),
      );
    }
    if (value.handle.workspaceId !== requirement.workspaceId) {
      issues.push(
        issue(
          'handle-workspace-mismatch',
          '/handle/workspaceId',
          'handle must bind the requested workspace',
        ),
      );
    }
    issues.push(
      ...subsetIssues(
        value.handle.grantedAuthorities,
        requirement.requestedAuthorities,
        'authority-broadening',
        '/handle/grantedAuthorities',
      ),
    );
  }

  if (requirement.operationClass === 'storage-only') {
    if (value.outcome !== 'daemonless' || value.handle !== null) {
      issues.push(
        issue(
          'storage-only-activated-host',
          '/outcome',
          'storage-only operations must remain daemonless',
        ),
      );
    }
  }

  if (requirement.operationClass === 'live-required') {
    if (value.outcome === 'degraded' || value.outcome === 'daemonless') {
      issues.push(
        issue(
          'live-required-downgrade',
          '/outcome',
          'live-required operations cannot downgrade',
        ),
      );
    }
    if (successful && (!value.handle || value.handle.state !== 'ready')) {
      issues.push(
        issue(
          'live-required-not-ready',
          '/handle',
          'a successful live-required receipt needs a ready handle',
        ),
      );
    }
    if (['failed', 'unknown'].includes(value.outcome) && value.error === null) {
      issues.push(
        issue(
          'live-required-failure-without-error',
          '/error',
          'failed or unknown live-required outcomes need a typed error',
        ),
      );
    }
  }

  if (
    requirement.operationClass === 'live-optional' &&
    value.outcome === 'degraded'
  ) {
    if (
      value.degraded !== true ||
      missing.length === 0 ||
      value.error === null
    ) {
      issues.push(
        issue(
          'optional-degrade-not-explicit',
          '/missingCapabilities',
          'optional degradation must name missing capabilities and a typed reason',
        ),
      );
    }
  }

  if (successful) {
    const achievedSet = new Set(achieved);
    for (const capability of required) {
      if (!achievedSet.has(capability)) {
        issues.push(
          issue(
            'required-capability-missing',
            '/achievedCapabilities',
            `${String(capability)} was required but not achieved`,
          ),
        );
      }
    }
    if (missing.length || value.degraded === true || value.error !== null) {
      issues.push(
        issue(
          'success-is-degraded',
          '/outcome',
          'successful activation cannot carry degraded or missing state',
        ),
      );
    }
  }
  return issues;
}

function validateLease(value, handle, prefix = '') {
  const issues = [];
  if (
    value.runtimeId !== handle.runtimeId ||
    value.generation !== handle.generation
  ) {
    issues.push(
      issue(
        'stale-generation',
        `${prefix}/generation`,
        'lease must bind the active handle generation',
      ),
    );
  }
  issues.push(
    ...subsetIssues(
      value.capabilities,
      handle.capabilities,
      'lease-capability-broadening',
      `${prefix}/capabilities`,
    ),
  );
  if (
    /^[0-9]+$/.test(String(value.issuedAtNs)) &&
    /^[0-9]+$/.test(String(value.expiresAtNs)) &&
    BigInt(value.expiresAtNs) <= BigInt(value.issuedAtNs)
  ) {
    issues.push(
      issue(
        'invalid-lease-window',
        `${prefix}/expiresAtNs`,
        'lease expiry must be after issuance',
      ),
    );
  }
  return issues;
}

function validateStandaloneLease(value, prefix = '') {
  const issues = [];
  if (value.state === 'active' && value.generation === '0') {
    issues.push(
      issue(
        'invalid-generation',
        `${prefix}/generation`,
        'an active lease requires a non-zero generation',
      ),
    );
  }
  if (
    /^[0-9]+$/.test(String(value.issuedAtNs)) &&
    /^[0-9]+$/.test(String(value.expiresAtNs)) &&
    BigInt(value.expiresAtNs) <= BigInt(value.issuedAtNs)
  ) {
    issues.push(
      issue(
        'invalid-lease-window',
        `${prefix}/expiresAtNs`,
        'lease expiry must be after issuance',
      ),
    );
  }
  return issues;
}

function validateSnapshot(value, contract) {
  const issues = [];
  const handles = list(value.handles);
  const authorityStates = new Set(contract.stateMachine.authorityBearingStates);
  const activeHandles = handles.filter((handle) =>
    authorityStates.has(handle.state),
  );
  const generations = new Set(activeHandles.map((handle) => handle.generation));
  for (let index = 0; index < handles.length; index += 1) {
    issues.push(
      ...validateHandle(handles[index], contract, `/handles/${index}`),
    );
  }
  if (generations.size > 1) {
    issues.push(
      issue(
        'dual-active-generation',
        '/handles',
        'one runtime identity cannot expose two authority-bearing generations',
      ),
    );
  }
  if (generations.size === 1 && !generations.has(value.activeGeneration)) {
    issues.push(
      issue(
        'active-generation-mismatch',
        '/activeGeneration',
        'snapshot active generation must match its authority-bearing handle',
      ),
    );
  }
  if (generations.size === 0 && value.activeGeneration !== null) {
    issues.push(
      issue(
        'active-generation-without-handle',
        '/activeGeneration',
        'snapshot cannot retain an active generation without an active handle',
      ),
    );
  }
  const activeHandle = activeHandles.find(
    (handle) => handle.generation === value.activeGeneration,
  );
  if (activeHandle) {
    for (let index = 0; index < list(value.leases).length; index += 1) {
      issues.push(
        ...validateLease(value.leases[index], activeHandle, `/leases/${index}`),
      );
    }
  } else if (list(value.leases).some((lease) => lease.state === 'active')) {
    issues.push(
      issue(
        'active-lease-without-handle',
        '/leases',
        'an active lease requires an active generation',
      ),
    );
  }
  return issues;
}

export function validateRuntimeContractValue(target, value, contract) {
  if (target === 'runtimeRequirement')
    return validateRequirement(object(value), contract);
  if (target === 'runtimeReadiness') return validateReadiness(object(value));
  if (target === 'runtimeHandle')
    return validateHandle(object(value), contract);
  if (target === 'runtimeLease') return validateStandaloneLease(object(value));
  if (target === 'activationReceipt')
    return validateReceipt(object(value), contract);
  if (target === 'runtimeSnapshot')
    return validateSnapshot(object(value), contract);
  return [
    issue(
      'unknown-target',
      '/',
      `unknown runtime contract target: ${String(target)}`,
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
  if (operation.operation === 'remove') {
    let target = value;
    for (const segment of operation.path.slice(0, -1)) target = target[segment];
    delete target[operation.path.at(-1)];
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

export async function checkRuntimeContract(root = ROOT) {
  const contractPath = path.join(root, path.relative(ROOT, CONTRACT_PATH));
  const fixtureRoot = path.join(root, path.relative(ROOT, FIXTURE_ROOT));
  const contract = readJson(contractPath);
  const registry = readJson(
    path.join(root, 'framework', 'contract', 'kungfu-contracts.registry.json'),
  );
  if (contract.schema !== 'kungfu.runtime.contract/v1')
    throw new Error('runtime contract schema mismatch');
  if (contract.weldedSurface !== 'runtime-activation-contract')
    throw new Error('runtime welded surface mismatch');
  const registryEntry = list(registry.contracts).find(
    (entry) => entry.surface === 'runtime',
  );
  if (!registryEntry)
    throw new Error('runtime contract is not registered in KFD-1');
  if (registryEntry.source !== 'framework/runtime/kungfu-runtime.contract.json')
    throw new Error('runtime registry source mismatch');

  const capabilityIds = list(contract.capabilities).map((item) => item.id);
  if (new Set(capabilityIds).size !== capabilityIds.length)
    throw new Error('runtime capability ids must be unique');
  const operationRows = list(contract.operationRegistry?.operations);
  const operationIds = operationRows.map((item) => item.id);
  if (
    contract.operationRegistry?.schema !==
    'kungfu.runtime-operation-registry/v1'
  )
    throw new Error('runtime operation registry schema mismatch');
  if (new Set(operationIds).size !== operationIds.length)
    throw new Error('runtime operation ids must be unique');
  const operationClasses = new Set(
    Object.keys(contract.operationClasses || {}),
  );
  const capabilitySet = new Set(capabilityIds);
  const authoritySet = new Set(contract.authorities?.activation?.grants || []);
  for (const operation of operationRows) {
    if (!operationClasses.has(operation.operationClass))
      throw new Error(`runtime operation class is unknown: ${operation.id}`);
    if (
      list(operation.requiredCapabilities).some(
        (capability) => !capabilitySet.has(capability),
      )
    )
      throw new Error(
        `runtime operation capability is unknown: ${operation.id}`,
      );
    if (
      list(operation.requestedAuthorities).some(
        (authority) => !authoritySet.has(authority),
      )
    )
      throw new Error(
        `runtime operation authority is unknown: ${operation.id}`,
      );
    if (
      operation.operationClass === 'storage-only' &&
      (list(operation.requiredCapabilities).length ||
        list(operation.requestedAuthorities).length)
    )
      throw new Error(
        `storage-only runtime operation cannot request live authority: ${operation.id}`,
      );
    if (
      operation.operationClass === 'live-required' &&
      !list(operation.requiredCapabilities).length
    )
      throw new Error(
        `live-required runtime operation needs a capability: ${operation.id}`,
      );
  }
  if (contract.hostKinds.publicSemanticsDependOnHostKind !== false)
    throw new Error('public runtime semantics must remain topology-neutral');
  if (
    list(contract.hostKinds.reservedNonClaims).some(
      (item) => item.id === 'embedded' && item.productionEligible !== false,
    )
  )
    throw new Error('embedded runtime host must remain an explicit non-claim');

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
        `runtime contract metadata failed schema validation: ${JSON.stringify(contractIssues)}`,
      );
    ajv.addSchema(contract.valueSchemaBundle);
    for (const target of [
      'runtimeRequirement',
      'runtimeReadiness',
      'runtimeHandle',
      'runtimeLease',
      'activationReceipt',
      'runtimeSnapshot',
    ]) {
      const validate = ajv.getSchema(
        `${contract.valueSchemaBundle.$id}#/$defs/${target}`,
      );
      if (!validate)
        throw new Error(`runtime schema target cannot be resolved: ${target}`);
      validators.set(target, validate);
    }
    schemaValidation = 'passed';
  }

  for (const fixture of validCases) {
    const issues = validateRuntimeContractValue(
      fixture.target,
      fixture.value,
      contract,
    );
    const validate = validators.get(fixture.target);
    if (validate) issues.push(...schemaErrors(validate, fixture.value));
    if (issues.length)
      throw new Error(
        `valid runtime fixture failed: ${fixture.id} ${JSON.stringify(issues)}`,
      );
  }

  for (const fixture of invalidCases) {
    const base = byId.get(fixture.base);
    if (!base)
      throw new Error(`invalid fixture has unknown base: ${fixture.base}`);
    const value = structuredClone(base.value);
    for (const operation of fixture.operations)
      applyOperation(value, operation);
    const issues = validateRuntimeContractValue(base.target, value, contract);
    const validate = validators.get(base.target);
    if (validate) issues.push(...schemaErrors(validate, value));
    if (!issues.some((item) => item.code === fixture.issue)) {
      throw new Error(
        `negative runtime fixture did not prove ${fixture.issue}: ${fixture.id} ${JSON.stringify(issues)}`,
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
