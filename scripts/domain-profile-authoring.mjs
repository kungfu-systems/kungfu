#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'framework/profile/kungfu-domain-profile-authoring.contract.json',
);
const DOC_PATH = path.join(
  ROOT,
  'docs/architecture/domain-profile-authoring.md',
);
const EXAMPLE_PATH = path.join(
  ROOT,
  'tests/fixtures/domain-profile-authoring/course-production/domain-profile.json',
);
const ARTIFACT_PATH = path.join(
  ROOT,
  'config/profile/kungfu-domain-profile-authoring.contract.json',
);

const RESPONSIBILITIES = ['fact', 'episode', 'pursuit', 'atlas', 'warrant'];
const POLICY_OWNERS = {
  claim: 'pursuit',
  assessment: 'atlas',
  decision: 'warrant',
  admission: 'warrant',
};
const REQUIRED_MIGRATION_PRESERVES = [
  'fact-identity',
  'episode-identity',
  'responsibility-separation',
  'historical-cut-interpretation',
];

export function readDomainProfileAuthoringContract() {
  return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
}

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function assertUnique(values, code, label) {
  if (new Set(values).size !== values.length)
    fail(code, `${label} must be unique`);
}

const jsonFile = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

export function createReferencePackageFiles(contract) {
  const profile = contract.referenceProfile;
  const files = new Map();
  files.set('domain-profile.json', jsonFile(profile));
  for (const object of profile.objects) {
    files.set(
      object.schema.path,
      jsonFile({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: `https://kungfu.link/schema/reference/course-production/${object.id}.json`,
        type: 'object',
        additionalProperties: true,
        required: ['id', 'state'],
        properties: {
          id: { type: 'string', minLength: 1 },
          state: { enum: object.states },
        },
      }),
    );
  }
  for (const [kind, policy] of Object.entries(profile.policies)) {
    files.set(
      policy.artifact.path,
      jsonFile({
        schema: 'kungfu.reference.course-production-policy/v1',
        kind,
        owner: policy.owner,
        effect: 'declarative-only',
      }),
    );
  }

  const put = (file, value) => files.set(file, jsonFile(value));
  const ref = (file) => ({ path: file, sha256: sha256(files.get(file)) });
  put('contracts/world.json', {
    schema: 'kungfu.reference.contract-world/v1',
    profile: ref('domain-profile.json'),
    authority: 'declarative-only',
  });
  put('contracts/course-production.json', {
    schema: 'kungfu.reference.fact-surface/v1',
    objects: profile.objects.map((object) => ({
      id: object.id,
      responsibility: object.responsibility,
      schema: object.schema,
    })),
  });
  put('compatibility/v1.json', profile.compatibility);
  put('claims/release-ready.json', {
    schema: 'kungfu.reference.claim/v1',
    owner: profile.policies.claim.owner,
    subject: 'course-map',
  });
  put('assessments/release-ready.json', {
    schema: 'kungfu.reference.assessment/v1',
    owner: profile.policies.assessment.owner,
    policy: profile.policies.assessment.artifact,
  });
  put('actions/registry.json', {
    schema: 'kungfu.reference.action-registry/v1',
    actions: profile.operations,
  });
  put('views/registry.json', {
    schema: 'kungfu.reference.view-registry/v1',
    views: profile.objects.map((object) => ({
      id: `${object.id}-detail`,
      object: object.id,
    })),
  });
  put('migrations/registry.json', {
    schema: 'kungfu.reference.migration-registry/v1',
    migrations: profile.migrations,
  });
  put('permissions.json', {
    schema: 'kungfu.profile-permissions/v1',
    capabilities: profile.capabilities,
  });
  put('qualification/profile.json', {
    schema: 'kungfu.reference.qualification-profile/v1',
    checks: contract.qualification.semanticChecks,
    activationAdmission: contract.lifecycle.activationAdmission,
  });
  put('profile.json', {
    schema: 'kungfu.profile-suite/v1',
    id: profile.package.profileSuiteId,
    title: profile.title,
    version: profile.version,
    members: {
      required: ['course-production-domain'],
      optional: [],
    },
    kfd1: {
      contractWorld: ref('contracts/world.json'),
      factSurfaces: [ref('contracts/course-production.json')],
      reducers: [],
      compatibility: ref('compatibility/v1.json'),
    },
    kfd2: {
      claims: [ref('claims/release-ready.json')],
      purposes: ['course-release'],
      policies: [ref('assessments/release-ready.json')],
    },
    actions: { registry: ref('actions/registry.json') },
    views: { registry: ref('views/registry.json') },
    migrations: { registry: ref('migrations/registry.json') },
    permissions: { registry: ref('permissions.json') },
    qualification: { profile: ref('qualification/profile.json') },
  });
  put('package.json', {
    name: '@kungfu-tech/reference-course-production-profile',
    version: profile.version,
    private: true,
    license: profile.package.license,
    kungfuConfig: {
      key: 'course-production-suite',
      suite: {
        title: profile.title,
        members: ['course-production-domain'],
        profile: 'profile.json',
      },
    },
  });
  put('members/course-production-domain/package.json', {
    name: '@kungfu-tech/reference-course-production-domain',
    version: profile.version,
    private: true,
    license: profile.package.license,
    kungfuConfig: { key: 'course-production-domain' },
  });
  return files;
}

export function validateDomainProfileDeclaration(declaration, contract) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(contract.declarationSchema);
  if (!validate(declaration))
    fail('schema-invalid', JSON.stringify(validate.errors));

  const objectIds = declaration.objects.map((object) => object.id);
  const operationIds = declaration.operations.map((operation) => operation.id);
  assertUnique(objectIds, 'object-id-duplicate', 'object ids');
  assertUnique(operationIds, 'operation-id-duplicate', 'operation ids');

  const objects = new Map(
    declaration.objects.map((object) => [object.id, object]),
  );
  const operations = new Map(
    declaration.operations.map((operation) => [operation.id, operation]),
  );
  const mappings = new Map();
  for (const mapping of declaration.responsibilityMappings) {
    if (mappings.has(mapping.responsibility))
      fail('role-fusion', `duplicate ${mapping.responsibility} mapping`);
    mappings.set(mapping.responsibility, mapping);
    const object = objects.get(mapping.object);
    if (!object)
      fail(
        'object-reference-unknown',
        `unknown mapped object ${mapping.object}`,
      );
    if (object.responsibility !== mapping.responsibility)
      fail(
        'role-fusion',
        `${mapping.object} changes responsibility at the mapping edge`,
      );
    const expectedAuthority =
      mapping.responsibility === 'fact'
        ? 'fact-reference'
        : mapping.responsibility === 'episode'
          ? 'episode-reference'
          : 'domain-policy';
    if (mapping.authority !== expectedAuthority)
      fail(
        'undeclared-authority',
        `${mapping.responsibility} cannot claim ${mapping.authority}`,
      );
  }
  if (
    mappings.size !== RESPONSIBILITIES.length ||
    RESPONSIBILITIES.some((role) => !mappings.has(role))
  )
    fail(
      'responsibility-mapping-incomplete',
      'all five responsibilities are required',
    );

  for (const object of declaration.objects) {
    for (const relation of object.relations) {
      if (!objects.has(relation))
        fail('object-reference-unknown', `${object.id} relates to ${relation}`);
    }
  }
  for (const operation of declaration.operations) {
    if (!objects.has(operation.object))
      fail(
        'object-reference-unknown',
        `${operation.id} targets ${operation.object}`,
      );
    if (!declaration.capabilities.includes(operation.capability))
      fail('capability-undeclared', `${operation.capability} is not declared`);
  }
  for (const workflow of declaration.workflows) {
    const object = objects.get(workflow.object);
    if (!object)
      fail(
        'object-reference-unknown',
        `${workflow.id} targets ${workflow.object}`,
      );
    const states = new Set(object.states);
    if (!states.has(workflow.initial))
      fail(
        'workflow-state-unknown',
        `${workflow.initial} is not an object state`,
      );
    for (const state of workflow.terminal) {
      if (!states.has(state))
        fail('workflow-state-unknown', `${state} is not an object state`);
    }
    for (const transition of workflow.transitions) {
      if (!states.has(transition.from) || !states.has(transition.to))
        fail(
          'workflow-state-unknown',
          `${transition.from} -> ${transition.to}`,
        );
      const operation = operations.get(transition.operation);
      if (!operation || operation.object !== workflow.object)
        fail('operation-reference-unknown', transition.operation);
      if (
        transition.requires.some(
          (responsibility) => !operation.requires.includes(responsibility),
        )
      )
        fail('workflow-authority-drift', transition.operation);
    }
  }

  for (const [policy, owner] of Object.entries(POLICY_OWNERS)) {
    if (declaration.policies[policy].owner !== owner)
      fail('policy-role-fusion', `${policy} must remain owned by ${owner}`);
  }
  for (const role of ['episode', 'warrant']) {
    if (!declaration.settlement.requires.includes(role))
      fail('settlement-authority-missing', `settlement must require ${role}`);
  }
  if (declaration.cutProjection.omissions.length === 0)
    fail('cut-omissions-missing', 'Cut projection must declare omissions');

  if (
    declaration.dependencies.some(
      (dependency) => dependency.id === declaration.id,
    )
  )
    fail('dependency-cycle', 'a Profile cannot depend on itself');
  assertUnique(
    declaration.dependencies.map((dependency) => dependency.id),
    'dependency-duplicate',
    'dependency ids',
  );

  for (const migration of declaration.migrations) {
    if (migration.from === migration.to)
      fail('migration-cycle', `${migration.from} cannot migrate to itself`);
    if (
      REQUIRED_MIGRATION_PRESERVES.some(
        (invariant) => !migration.preserves.includes(invariant),
      )
    )
      fail('migration-incompatible', `${migration.from} -> ${migration.to}`);
    if (migration.rollback !== 'required')
      fail(
        'migration-rollback-missing',
        `${migration.from} -> ${migration.to}`,
      );
  }

  return declaration;
}

export function validateActivationAdmission(evidence, contract) {
  const required = contract.lifecycle.activationAdmission;
  const missing = required.filter((key) => evidence[key] !== true);
  if (missing.length > 0)
    fail('activation-admission-incomplete', missing.join(', '));
  return evidence;
}

export function renderDomainProfileAuthoring(contract) {
  const operations = contract.lifecycle.operations
    .map((operation) => `\`${operation}\``)
    .join(', ');
  const checks = contract.qualification.semanticChecks
    .map((check) => `- \`${check}\``)
    .join('\n');
  const nonClaims = contract.nonClaims.map((claim) => `- ${claim}`).join('\n');
  return `# Domain Profile authoring contract

The machine authority for this document is
[kungfu-domain-profile-authoring.contract.json](../../framework/profile/kungfu-domain-profile-authoring.contract.json).
The reference KFX Profile Suite source package is generated from that contract.
Edit the contract, not the generated example or this document.

A Domain Profile declares adopter-specific objects, responsibility mappings,
workflows, operations, policy artifacts, settlement, Cut projection, and
migration. It consumes Action Geometry, Fact, Episode, KFX Profile Suite, and
Project Cut authority; it does not replace any of them. Core computes installed
roots and owns lifecycle mutation receipts.

## Authoring and lifecycle

The declaration schema is kungfu.domain-profile-declaration/v1. The public
lifecycle vocabulary is: ${operations}.

Activation is fail closed until the exact declaration and Profile Suite roots,
a valid supply-chain signature, a fresh qualification receipt, a compatible
migration path, and explicit capability grants are all present. A source
declaration or successful schema check is not activation evidence.

## Responsibility boundary

Every Profile maps exactly one domain object to each of Fact, Episode, Pursuit,
Atlas, and Warrant. Physical storage or UI components may be shared, but the
five responsibilities remain independently inspectable. Claim, Assessment,
Decision, and Admission policy owners are fixed by the authoring contract and
cannot be fused for convenience.

## Qualification checks

${checks}

## Reference Profile

The generated Course Production package is deliberately non-software. It is a
hash-closed KFX Profile Suite source tree with domain objects, a release
workflow, explicit residual risk, a settlement requiring both Episode and
Warrant, and a Cut projection with declared omissions. It is an authoring
fixture, not a signed installable package or a qualification receipt.

## Non-claims

${nonClaims}
`;
}

function writeGenerated(contract) {
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(EXAMPLE_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, renderDomainProfileAuthoring(contract));
  const exampleRoot = path.dirname(EXAMPLE_PATH);
  for (const [relative, value] of createReferencePackageFiles(contract)) {
    const file = path.join(exampleRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  fs.copyFileSync(CONTRACT_PATH, ARTIFACT_PATH);
}

function checkGenerated(contract) {
  const expected = [
    [DOC_PATH, renderDomainProfileAuthoring(contract)],
    [ARTIFACT_PATH, fs.readFileSync(CONTRACT_PATH, 'utf8')],
  ];
  const exampleRoot = path.dirname(EXAMPLE_PATH);
  for (const [relative, value] of createReferencePackageFiles(contract))
    expected.push([path.join(exampleRoot, relative), value]);
  for (const [file, value] of expected) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== value)
      fail(
        'generated-artifact-stale',
        `${path.relative(ROOT, file)}; run ./shifu run render:domain-profile-authoring`,
      );
  }
}

function main() {
  const contract = readDomainProfileAuthoringContract();
  validateDomainProfileDeclaration(contract.referenceProfile, contract);
  const args = new Set(process.argv.slice(2));
  if (args.has('--write')) {
    writeGenerated(contract);
    process.stdout.write(
      '[domain-profile-authoring] generated docs and reference package\n',
    );
    return;
  }
  if (args.has('--check')) {
    checkGenerated(contract);
    process.stdout.write(
      '[domain-profile-authoring] generated artifacts are current\n',
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify(contract.referenceProfile, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
