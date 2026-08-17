// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(HERE, relative), 'utf8'));

export const contract = readJson('assignment-runtime.contract.json');
export const envelopeSchema = readJson(
  'schema/assignment-runtime-envelope-v1.schema.json',
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value) => Number.isFinite(Date.parse(value)),
});
const validateSchema = ajv.compile(envelopeSchema);

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const forbiddenArgumentKeys = new Set([
  'directStorageMutation',
  'electronChannel',
  'filesystemPath',
  'journalPath',
  'postgresTable',
  'sqliteTable',
  'storagePath',
]);

function issue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function findForbiddenArgument(value, pathValue = '/payload/arguments') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathValue}/${key}`;
    if (forbiddenArgumentKeys.has(key)) return childPath;
    const nested = findForbiddenArgument(child, childPath);
    if (nested) return nested;
  }
  return null;
}

function schemaIssue(errors) {
  const first = errors?.[0];
  return issue(
    'schema-invalid',
    first?.instancePath || '/',
    first?.message || 'envelope does not match the declared schema',
  );
}

export function validateEnvelope(value) {
  const issues = [];
  const realm = value?.realm;
  if (
    realm &&
    (!stableId.test(String(realm.realmId || '')) ||
      !stableId.test(String(realm.generation || '')))
  ) {
    issues.push(
      issue(
        'malformed-identity',
        '/realm',
        'realmId and generation must be non-empty stable identities',
      ),
    );
    return { ok: false, issues };
  }

  if (!validateSchema(value)) {
    issues.push(schemaIssue(validateSchema.errors));
    return { ok: false, issues };
  }

  const knownCapabilities = new Set(contract.capabilities);
  if (value.schema === 'kungfu.assignment-runtime.request/v1') {
    if (!contract.operations.some((row) => row.id === value.operation)) {
      issues.push(
        issue('invalid-command', '/operation', 'operation is not declared'),
      );
    }
    for (const capability of value.client.requestedCapabilities) {
      if (!knownCapabilities.has(capability)) {
        issues.push(
          issue(
            'unsupported-capability',
            '/client/requestedCapabilities',
            `capability is not declared: ${capability}`,
          ),
        );
      }
    }
    if (value.operation === 'command.submit') {
      const forbidden = findForbiddenArgument(value.payload.arguments);
      if (forbidden) {
        issues.push(
          issue(
            'authority-bypass',
            forbidden,
            'callers may not name or mutate backend implementation details',
          ),
        );
      }
    }
  } else {
    const knownErrors = new Set(contract.errors.map((row) => row.code));
    if (value.error && !knownErrors.has(value.error.code)) {
      issues.push(
        issue(
          'invalid-command',
          '/error/code',
          `error code is not stable in this protocol: ${value.error.code}`,
        ),
      );
    }
    for (const capability of value.capabilities.selected) {
      if (!value.capabilities.supported.includes(capability)) {
        issues.push(
          issue(
            'unsupported-capability',
            '/capabilities/selected',
            'selected capabilities must be a subset of supported capabilities',
          ),
        );
      }
    }
    if (value.result?.command?.disposition === 'replayed') {
      if (
        !value.result.command.originalReceiptRoot ||
        value.receipts.length === 0
      ) {
        issues.push(
          issue(
            'idempotency-conflict',
            '/result/command',
            'a replay must return the original receipt root without a second mutation',
          ),
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateContract() {
  const errors = [];
  const validateContractSchema = ajv.compile(contract.contractSchema);
  if (!validateContractSchema(contract)) {
    errors.push(
      `contract schema mismatch: ${JSON.stringify(validateContractSchema.errors)}`,
    );
  }
  const capabilitySet = new Set(contract.capabilities);
  const operationIds = new Set();
  for (const operation of contract.operations) {
    if (operationIds.has(operation.id))
      errors.push(`duplicate operation: ${operation.id}`);
    operationIds.add(operation.id);
    if (!capabilitySet.has(operation.capability))
      errors.push(
        `operation capability is undeclared: ${operation.capability}`,
      );
  }
  const requiredErrors = [
    'stale-revision',
    'idempotency-conflict',
    'unsupported-capability',
    'malformed-identity',
    'ambiguous-identity',
    'backend-unavailable',
    'event-resume-gap',
    'authority-bypass',
  ];
  const errorSet = new Set(contract.errors.map((row) => row.code));
  for (const code of requiredErrors) {
    if (!errorSet.has(code)) errors.push(`required error is absent: ${code}`);
  }
  if (contract.localRuntimeProfile.publicPathContract !== false)
    errors.push('the Local Runtime must not expose a public path contract');
  if (
    contract.implementationStatus.clusterRuntime !== 'not-started-out-of-scope'
  )
    errors.push('Cluster Runtime must remain explicitly out of scope');
  return { ok: errors.length === 0, errors };
}
