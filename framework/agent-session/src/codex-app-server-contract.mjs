// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_FILE = 'kungfu-codex-app-server.contract.json';

export function resolveCodexAppServerContractRoot({
  moduleUrl = import.meta.url,
  env = process.env,
} = {}) {
  if (env.KUNGFU_AGENT_SESSION_CONTRACT_ROOT) {
    return path.resolve(env.KUNGFU_AGENT_SESSION_CONTRACT_ROOT);
  }
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDirectory, '..'),
    path.resolve(moduleDirectory, '..', '..', 'agent-session'),
    path.resolve(
      moduleDirectory,
      '..',
      'app',
      'node_modules',
      '@kungfu-tech',
      'agent-session',
    ),
  ];
  return (
    candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, CONTRACT_FILE)),
    ) ?? candidates[0]
  );
}

const ROOT = resolveCodexAppServerContractRoot();
const CONTRACT_SCHEMA = 'kungfu.codex-app-server.adapter-contract/v1';
const MANIFEST_SCHEMA = 'kungfu.codex-app-server.schema-manifest/v1';
const BUNDLE_ALGORITHM =
  'sha256-path-nul-canonical-json-size-nul-canonical-json-sha256-lf/v1';
const INVENTORY_BY_DIRECTION = {
  'client-request': 'clientRequests',
  'client-notification': 'clientNotifications',
  'server-request': 'serverRequests',
  'server-notification': 'serverNotifications',
};

export class CodexAppServerContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexAppServerContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexAppServerContractError(code, message);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function atPointer(value, pointer) {
  if (pointer === '') return value;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !hasOwn(current, key)
    ) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function loadCodexAppServerContract() {
  return readJson(CONTRACT_FILE);
}

export function loadCodexAppServerSchemaManifest(
  contract = loadCodexAppServerContract(),
) {
  return readJson(contract.surfacePin.schemaManifest);
}

export function verifyCodexAppServerSchemaManifest(manifest) {
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    fail(
      'schema-manifest-schema',
      'Codex App Server schema manifest version is unsupported',
    );
  }
  if (manifest.bundle?.algorithm !== BUNDLE_ALGORITHM) {
    fail(
      'schema-manifest-algorithm',
      'Codex App Server schema manifest hash algorithm drifted',
    );
  }
  if (
    !Array.isArray(manifest.bundle.files) ||
    manifest.bundle.files.length === 0
  ) {
    fail(
      'schema-manifest-files',
      'Codex App Server schema manifest has no files',
    );
  }
  const paths = manifest.bundle.files.map((file) => file.path);
  const sorted = [...paths].sort(compareUtf8);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((entry, index) => entry !== sorted[index])
  ) {
    fail(
      'schema-manifest-order',
      'Codex App Server schema manifest paths are not unique UTF-8 byte order',
    );
  }
  if (manifest.bundle.fileCount !== manifest.bundle.files.length) {
    fail(
      'schema-manifest-count',
      'Codex App Server schema manifest file count drifted',
    );
  }
  const preimage = manifest.bundle.files
    .map((file) => {
      if (
        typeof file.path !== 'string' ||
        !Number.isSafeInteger(file.canonicalBytes) ||
        file.canonicalBytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      ) {
        fail(
          'schema-manifest-record',
          'Codex App Server schema manifest contains an invalid file record',
        );
      }
      return `${file.path}\0${file.canonicalBytes}\0${file.sha256}\n`;
    })
    .join('');
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  if (digest !== manifest.bundle.sha256) {
    fail(
      'schema-manifest-digest',
      'Codex App Server schema manifest bundle digest is not reproducible',
    );
  }
  return { fileCount: manifest.bundle.fileCount, sha256: digest };
}

function verifyMapping(manifest, mapping, keys, schemaFiles) {
  const inventoryName = INVENTORY_BY_DIRECTION[mapping.direction];
  if (!inventoryName)
    fail(
      'contract-direction',
      `unsupported mapping direction: ${mapping.direction}`,
    );
  const key = `${mapping.direction}:${mapping.method}`;
  if (keys.has(key))
    fail(
      'contract-duplicate-method',
      `duplicate Codex App Server mapping: ${key}`,
    );
  keys.add(key);
  if (
    !manifest.protocolInventory[inventoryName].methods.includes(mapping.method)
  ) {
    fail(
      'contract-method-drift',
      `mapped method is absent from pinned schema: ${key}`,
    );
  }
  if (!schemaFiles.has(mapping.schemaFile)) {
    fail(
      'contract-schema-file-drift',
      `mapped schema file is absent from pinned bundle: ${mapping.schemaFile}`,
    );
  }
  if (
    mapping.responseSchemaFile &&
    !schemaFiles.has(mapping.responseSchemaFile)
  ) {
    fail(
      'contract-schema-file-drift',
      `mapped response schema file is absent from pinned bundle: ${mapping.responseSchemaFile}`,
    );
  }
  if (!Array.isArray(mapping.requiredPaths)) {
    fail(
      'contract-required-paths',
      `mapped method has no required path list: ${key}`,
    );
  }
}

function verifyResponseMapping(mapping, keys, schemaFiles) {
  if (!['server-response', 'client-response'].includes(mapping.direction)) {
    fail(
      'contract-direction',
      `unsupported response direction: ${mapping.direction}`,
    );
  }
  if (
    !['client-request', 'server-request'].includes(mapping.requestDirection)
  ) {
    fail(
      'contract-direction',
      `unsupported response request direction: ${mapping.requestDirection}`,
    );
  }
  if (!['result', 'error'].includes(mapping.outcome)) {
    fail(
      'contract-response-outcome',
      `unsupported response outcome: ${mapping.outcome}`,
    );
  }
  const key = `${mapping.direction}:${mapping.outcome}`;
  if (keys.has(key))
    fail(
      'contract-duplicate-response',
      `duplicate Codex App Server response mapping: ${key}`,
    );
  keys.add(key);
  if (!schemaFiles.has(mapping.schemaFile)) {
    fail(
      'contract-schema-file-drift',
      `mapped schema file is absent from pinned bundle: ${mapping.schemaFile}`,
    );
  }
}

export function createCodexAppServerContractGate({
  contract = loadCodexAppServerContract(),
  manifest = loadCodexAppServerSchemaManifest(contract),
  cliVersion,
  initializeCapabilities = {},
}) {
  if (contract?.schema !== CONTRACT_SCHEMA) {
    fail(
      'contract-schema',
      'Codex App Server adapter contract version is unsupported',
    );
  }
  const verified = verifyCodexAppServerSchemaManifest(manifest);
  if (manifest.cliVersion !== contract.surfacePin.cliVersion) {
    fail(
      'qualification-source-version-drift',
      'Codex schema qualification source does not match the adapter contract',
    );
  }
  if (
    verified.sha256 !== contract.surfacePin.schemaBundleSha256 ||
    verified.fileCount !== contract.surfacePin.schemaBundleFileCount
  ) {
    fail(
      'schema-bundle-drift',
      'Codex App Server stable schema bundle does not match the qualified adapter contract',
    );
  }
  if (
    contract.surfacePin.experimentalApi !== false ||
    manifest.generator.experimental !== false ||
    initializeCapabilities.experimentalApi === true
  ) {
    fail(
      'experimental-api',
      'experimental Codex App Server capability is outside the adapter contract',
    );
  }
  if (
    initializeCapabilities.requestAttestation === true ||
    initializeCapabilities.mcpServerOpenaiFormElicitation === true ||
    (Array.isArray(initializeCapabilities.optOutNotificationMethods) &&
      initializeCapabilities.optOutNotificationMethods.length > 0)
  ) {
    fail(
      'capability-drift',
      'initialize capabilities would change the qualified event surface',
    );
  }

  const schemaFiles = new Set(manifest.bundle.files.map((file) => file.path));
  const keys = new Set();
  for (const mapping of contract.methodMappings) {
    verifyMapping(manifest, mapping, keys, schemaFiles);
  }
  const mappingByKey = new Map(
    contract.methodMappings.map((mapping) => [
      `${mapping.direction}:${mapping.method}`,
      Object.freeze({ ...mapping }),
    ]),
  );
  const responseKeys = new Set();
  for (const mapping of contract.responseMappings) {
    verifyResponseMapping(mapping, responseKeys, schemaFiles);
  }
  const responseByKey = new Map(
    contract.responseMappings.map((mapping) => [
      `${mapping.direction}:${mapping.outcome}`,
      Object.freeze({ ...mapping }),
    ]),
  );

  return Object.freeze({
    schema: 'kungfu.codex-app-server.contract-gate/v1',
    provider: 'codex',
    cliVersion,
    schemaBundleSha256: verified.sha256,
    experimentalApi: false,
    classify({ direction, message, requestMethod = null }) {
      if (
        message === null ||
        typeof message !== 'object' ||
        Array.isArray(message)
      ) {
        fail('invalid-envelope', 'Codex App Server message must be an object');
      }
      if (hasOwn(message, 'jsonrpc')) {
        fail(
          'jsonrpc-field',
          'Codex App Server envelopes must not contain a jsonrpc field',
        );
      }
      if (direction === 'server-response' || direction === 'client-response') {
        const hasResult = hasOwn(message, 'result');
        const hasError = hasOwn(message, 'error');
        if (hasResult === hasError) {
          fail(
            'invalid-response',
            'Codex App Server response must contain exactly one result or error',
          );
        }
        const outcome = hasError ? 'error' : 'result';
        const mapping = responseByKey.get(`${direction}:${outcome}`);
        if (
          !mapping ||
          typeof requestMethod !== 'string' ||
          requestMethod.length === 0
        ) {
          fail(
            'uncorrelated-response',
            'Codex App Server response requires an admitted request method',
          );
        }
        const requestMapping = mappingByKey.get(
          `${mapping.requestDirection}:${requestMethod}`,
        );
        if (!requestMapping) {
          fail(
            'uncorrelated-response',
            `Codex App Server response request is not admitted: ${requestMethod}`,
          );
        }
        for (const pointer of mapping.requiredPaths) {
          if (atPointer(message, pointer) === undefined) {
            fail(
              'missing-required-field',
              `Codex App Server response is missing ${pointer}: ${requestMethod}`,
            );
          }
        }
        return Object.freeze({
          schema: 'kungfu.codex-app-server.normalization-plan/v1',
          provider: 'codex',
          providerMethod: requestMethod,
          providerSchemaFile: requestMapping.responseSchemaFile,
          direction,
          normalizedSemantic: mapping.normalizedSemantic,
          interactionOperation: null,
          rawRetention: mapping.rawRetention,
          authority: mapping.authority,
          rawPointerRequired: true,
        });
      }
      if (typeof message.method !== 'string' || message.method.length === 0) {
        fail('missing-method', 'Codex App Server message has no exact method');
      }
      const mapping = mappingByKey.get(`${direction}:${message.method}`);
      if (!mapping) {
        if (direction === 'server-notification') {
          return Object.freeze({
            schema: 'kungfu.codex-app-server.normalization-plan/v1',
            provider: 'codex',
            providerMethod: message.method,
            providerSchemaFile: null,
            direction,
            normalizedSemantic: 'provider-notification-unclassified',
            interactionOperation: null,
            rawRetention: 'metadata-only',
            authority: 'provider-diagnostic-not-work-fact',
            rawPointerRequired: true,
          });
        }
        fail(
          'unknown-method',
          `Codex App Server method is not admitted: ${direction}:${message.method}`,
        );
      }
      for (const pointer of mapping.requiredPaths) {
        if (atPointer(message, pointer) === undefined) {
          fail(
            'missing-required-field',
            `Codex App Server message is missing ${pointer}: ${message.method}`,
          );
        }
      }
      return Object.freeze({
        schema: 'kungfu.codex-app-server.normalization-plan/v1',
        provider: 'codex',
        providerMethod: mapping.method,
        providerSchemaFile: mapping.schemaFile,
        direction: mapping.direction,
        normalizedSemantic: mapping.normalizedSemantic,
        interactionOperation: mapping.interactionOperation,
        rawRetention: mapping.rawRetention,
        authority: mapping.authority,
        rawPointerRequired: true,
      });
    },
  });
}
