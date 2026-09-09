#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH =
  'product/hub-starter/kungfu-hub-starter-docker.contract.json';
const SCHEMA_PATH =
  'product/hub-starter/schema/kungfu-hub-starter-docker-concept-v1.schema.json';
const ADR_ID = 'KF-ADR-019f9388-a139-7355-b9f2-f6dd9aa91042';

function issue(code, detail) {
  return { code, detail };
}

function containsAll(text, values) {
  return values.every((value) => text.includes(value));
}

export function collectHubStarterIssues(contract, root = ROOT) {
  const issues = [];
  const serviceIds = (contract.topology?.services || []).map(({ id }) => id);
  if (new Set(serviceIds).size !== serviceIds.length)
    issues.push(issue('duplicate-service', serviceIds.join(',')));
  if (!containsAll(serviceIds.join(' '), ['hub', 'verify']))
    issues.push(issue('required-service-missing', serviceIds.join(',')));

  for (const service of contract.topology?.services || []) {
    if (
      !service.runsAsNonRoot ||
      !service.readOnlyRootFilesystem ||
      service.privileged ||
      service.dockerSocket
    ) {
      issues.push(issue('unsafe-service', service.id));
    }
  }

  const writer = new Map();
  for (const volume of contract.storage?.volumes || []) {
    if (volume.hostPathAllowed)
      issues.push(issue('host-path-volume', volume.id));
    for (const service of volume.writers || []) {
      if (writer.has(volume.id))
        issues.push(issue('multiple-volume-writers', volume.id));
      writer.set(volume.id, service);
      if (!serviceIds.includes(service))
        issues.push(issue('unknown-volume-writer', `${volume.id}:${service}`));
    }
  }

  if (
    contract.networking?.hostNetwork ||
    contract.security?.dockerSocketMount ||
    contract.security?.privilegedContainers ||
    contract.security?.rootUser
  ) {
    issues.push(issue('unsafe-container-authority', 'host or root authority'));
  }
  if ((contract.networking?.publicPortsByDefault || []).length !== 0)
    issues.push(
      issue('public-port-default', 'default public ports must be empty'),
    );
  if (contract.storage?.realUserHomeMount)
    issues.push(
      issue('real-user-home-mount', 'real user Home must remain outside'),
    );
  if (
    contract.distribution?.imageStatus !== 'not-built-or-published' ||
    contract.distribution?.composeStatus !== 'not-implemented' ||
    contract.distribution?.buildPerformed ||
    contract.distribution?.publishPerformed ||
    contract.distribution?.daemonAccessed
  ) {
    issues.push(
      issue('concept-overclaim', 'distribution evidence exceeds concept'),
    );
  }
  if (contract.oneCommand?.implementationStatus !== 'not-implemented')
    issues.push(
      issue('one-command-overclaim', contract.oneCommand?.implementationStatus),
    );
  if (contract.compatibility?.floatingTagsAllowed !== false)
    issues.push(
      issue('floating-tag-admitted', 'floating tags must fail closed'),
    );

  const ladder = contract.evidenceLadder || [];
  const passed = ladder.filter(({ status }) => status === 'passed');
  if (passed.length !== 1 || passed[0]?.id !== 'concept-static')
    issues.push(
      issue('evidence-overclaim', passed.map(({ id }) => id).join(',')),
    );
  const ladderIds = new Set(ladder.map(({ id }) => id));
  for (const required of [
    'concept-static',
    'compose-render',
    'daemon-smoke',
    'restart-and-fencing',
    'backup-restore',
    'upgrade-rollback',
    'production-admission',
  ]) {
    if (!ladderIds.has(required))
      issues.push(issue('evidence-stage-missing', required));
  }

  const nonClaims = contract.nonClaims || [];
  for (const required of [
    'no-image-built-or-published',
    'no-compose-bundle-implemented',
    'no-docker-daemon-qualification',
    'no-one-command-cli-implemented',
    'no-production-fitness-security-or-slo-claim',
    'no-stable-release-line-opened',
  ]) {
    if (!nonClaims.includes(required))
      issues.push(issue('non-claim-missing', required));
  }

  for (const [key, value] of Object.entries(contract.authority || {})) {
    if (
      typeof value === 'string' &&
      !value.startsWith('http') &&
      !value.startsWith('@') &&
      !value.startsWith('protocols/') &&
      !fs.existsSync(path.join(root, value))
    ) {
      issues.push(issue('authority-path-missing', `${key}:${value}`));
    }
  }
  return issues.sort((left, right) => left.code.localeCompare(right.code));
}

async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export async function validateHubStarterRepository(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8'),
  );
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, SCHEMA_PATH), 'utf8'),
  );
  const Ajv2020 = await loadAjv2020();
  let schemaValid = true;
  let schemaErrors = [];
  let schemaValidation = 'skipped';
  if (Ajv2020) {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      schema,
    );
    schemaValid = validate(contract);
    schemaErrors = validate.errors || [];
    schemaValidation = 'passed';
  } else {
    console.warn(
      '[hub-starter] ajv not installed; topology, authority, safety, ' +
        'documentation, and non-claim checks still ran. Run `./shifu sync` ' +
        'to enable JSON Schema conformance locally; CI enforces it.',
    );
  }
  const issues = collectHubStarterIssues(contract, root);

  for (const documentPath of [
    'docs/architecture/hub-starter-docker.md',
    'docs/architecture/README.md',
    'docs/MAP.md',
    'docs/development/versioning.md',
    `docs/adr/${ADR_ID}.md`,
  ]) {
    const text = fs.readFileSync(path.join(root, documentPath), 'utf8');
    if (!text.includes('hub-starter') && !text.includes('Hub Starter'))
      issues.push(issue('documentation-link-missing', documentPath));
  }
  const architecture = fs.readFileSync(
    path.join(root, 'docs/architecture/hub-starter-docker.md'),
    'utf8',
  );
  if (!containsAll(architecture, [CONTRACT_PATH, ADR_ID, 'concept-only']))
    issues.push(issue('architecture-boundary-missing', 'contract/ADR/status'));

  return {
    ok: Boolean(schemaValid) && issues.length === 0,
    contract: CONTRACT_PATH,
    schema: SCHEMA_PATH,
    schemaValidation,
    schemaErrors,
    issues,
    passedEvidence: (contract.evidenceLadder || [])
      .filter(({ status }) => status === 'passed')
      .map(({ id }) => id),
  };
}

async function main() {
  const result = await validateHubStarterRepository();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
