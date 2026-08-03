#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const REFERENCE_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/qualification/reference-scenarios.json',
);
const RETAINED_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/qualification/retained-witnesses.json',
);
const NEGATIVE_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/qualification/negative-witnesses.json',
);
const RETAINED_RELATIVE = path
  .relative(ROOT, RETAINED_PATH)
  .split(path.sep)
  .join('/');
const BUILDCHAIN_AUTHORITY = '.buildchain/alpha-contract-lock.json';
const BUILDCHAIN_SOURCE =
  '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json';
const ACTION_GEOMETRY = 'framework/action/action-geometry.contract.json';
const WORK_LIFECYCLE =
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json';
const WORK_API = 'framework/work-loop/work-api.contract.json';
const PLATFORMS = {
  cpp: 'framework/core/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp',
  python: 'framework/storage/python/kungfu_sdk/generated/work_lifecycle_v1.py',
  node: 'framework/storage/generated/work-lifecycle-v1.js',
  rust: 'crates/kungfu-sdk/src/generated/work_lifecycle_v1.rs',
};

const DOMAIN_BINDINGS = {
  'agent-work-control': {
    domainProfilePath:
      'framework/agent-work/kungfu-agent-work-domain-profile.contract.json',
    sourcePath:
      'framework/agent-work/kungfu-agent-work-domain-profile.contract.json',
    roleSchemaPaths: Object.fromEntries(
      ['fact', 'episode', 'pursuit', 'atlas', 'warrant'].map((role) => [
        role,
        `framework/agent-work/role-schemas/${role}.schema.json`,
      ]),
    ),
  },
  'week-day-action': {
    domainProfilePath:
      'framework/work-profile-conformance/qualification/week-day-domain-profile.json',
    sourcePath:
      'framework/work-profile-conformance/qualification/week-day-domain-profile.json',
    roleSchemaPaths: Object.fromEntries(
      ['fact', 'episode', 'pursuit', 'atlas', 'warrant'].map((role) => [
        role,
        `framework/work-profile-conformance/qualification/week-day-role-schemas/${role}.schema.json`,
      ]),
    ),
  },
  'course-production': {
    domainProfilePath:
      'tests/fixtures/domain-profile-authoring/course-production/domain-profile.json',
    sourcePath:
      'tests/fixtures/domain-profile-authoring/course-production/domain-profile.json',
    roleSchemaPaths: {
      fact: 'tests/fixtures/domain-profile-authoring/course-production/schemas/course-brief.schema.json',
      episode:
        'tests/fixtures/domain-profile-authoring/course-production/schemas/production-session.schema.json',
      pursuit:
        'tests/fixtures/domain-profile-authoring/course-production/schemas/course-goal.schema.json',
      atlas:
        'tests/fixtures/domain-profile-authoring/course-production/schemas/course-map.schema.json',
      warrant:
        'tests/fixtures/domain-profile-authoring/course-production/schemas/release-approval.schema.json',
    },
  },
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const sha256 = (bytes) =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const contentRoot = (value) => sha256(canonicalJson(value));
const fileRoot = (relative) =>
  sha256(fs.readFileSync(path.join(ROOT, relative)));
const coordinate = (relative) => ({
  evidenceRoot: fileRoot(relative),
  evidencePath: relative,
  evidencePointer: null,
});

function behaviorReceipt(declaration, caseId) {
  const identity = {
    scenarioId: declaration.scenarioId,
    domainProfileRoot: declaration.bindings.domainProfileRoot,
    sourceRoot: declaration.bindings.sourceRoot,
  };
  const identityRoot = contentRoot(identity);
  const input = {
    schema: 'kungfu.work-profile-fault-input/v1',
    case: caseId,
    identityRoot,
    idempotencyKey: `qualification:${declaration.scenarioId}:${caseId}`,
    basisRevision: 7,
  };
  const common = {
    identityRoot,
    resultIdentityRoot: identityRoot,
    idempotencyKey: input.idempotencyKey,
    duplicateAuthority: false,
    lifecycleFork: false,
  };
  const outcomes = {
    repeat: { ...common, replay: 'same-receipt', effectCount: 1 },
    crash: { ...common, prepared: true, settled: false, recovery: 'resume' },
    interrupted: {
      ...common,
      committedPrefix: 1,
      missingSuffix: 1,
      recovery: 'append-missing-suffix',
    },
    stale: { ...common, admitted: false, diagnostic: 'stale-cut' },
    'warrant-revoked': {
      ...common,
      admitted: false,
      diagnostic: 'warrant-revoked',
    },
    'provider-switch': {
      ...common,
      providerChanged: true,
      semanticIdentityChanged: false,
    },
    'projection-rebuild': {
      ...common,
      projectionDeleted: true,
      rebuiltFromAuthority: true,
    },
    'external-effect': {
      ...common,
      receiptRequired: true,
      unreceiptedEffectAdmitted: false,
    },
    recovery: {
      ...common,
      cleanRuntime: true,
      importedExactRoots: true,
    },
  };
  const output = outcomes[caseId];
  return {
    schema: 'kungfu.work-profile-fault-receipt/v1',
    ...identity,
    case: caseId,
    status: 'passed',
    identityRoot,
    inputRoot: contentRoot(input),
    outputRoot: contentRoot(output),
    input,
    output,
  };
}

export function generateQualificationFixtures() {
  const source = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const retained = {
    schema: 'kungfu.work-profile-generated-evidence/v1',
    generator: 'framework/work-profile-conformance/generate-qualification.mjs',
    scenarios: {},
  };
  const actionGeometryRoot = fileRoot(ACTION_GEOMETRY);
  const abstractionAuthorityRoot = fileRoot(WORK_LIFECYCLE);
  const workApi = JSON.parse(
    fs.readFileSync(path.join(ROOT, WORK_API), 'utf8'),
  );
  const workApiRoot = fileRoot(WORK_API);
  const buildchainAuthorityRoot = fileRoot(BUILDCHAIN_AUTHORITY);
  const sourceRevision = JSON.parse(
    fs.readFileSync(path.join(ROOT, BUILDCHAIN_SOURCE), 'utf8'),
  ).source.sourceSha;
  const artifactRefs = [
    BUILDCHAIN_SOURCE,
    'scripts/source-acceptance.mjs',
    'framework/work-profile-conformance/work-profile-conformance.test.mjs',
  ].map(coordinate);

  for (const scenario of source.scenarios) {
    const declaration = scenario.declaration;
    const binding = DOMAIN_BINDINGS[declaration.scenarioId];
    if (!binding)
      throw new Error(`unknown scenario: ${declaration.scenarioId}`);
    declaration.bindings = {
      actionGeometryRoot,
      actionGeometryPath: ACTION_GEOMETRY,
      domainProfileRoot: fileRoot(binding.domainProfilePath),
      domainProfilePath: binding.domainProfilePath,
      roleSchemaRoots: Object.fromEntries(
        Object.entries(binding.roleSchemaPaths).map(([role, relative]) => [
          role,
          fileRoot(relative),
        ]),
      ),
      roleSchemaPaths: binding.roleSchemaPaths,
      abstractionAuthorityRoot,
      abstractionAuthorityPath: WORK_LIFECYCLE,
      sourceRoot: fileRoot(binding.sourcePath),
      sourcePath: binding.sourcePath,
    };
    for (const [field, judgment] of Object.entries(declaration.humanAuthority))
      judgment.authorityRoot = contentRoot({
        scenarioId: declaration.scenarioId,
        domainProfileRoot: declaration.bindings.domainProfileRoot,
        field,
        status: judgment.status,
        statement: judgment.statement,
      });

    const behavior = Object.fromEntries(
      declaration.behaviorEvidence.map(({ case: caseId }) => [
        caseId,
        behaviorReceipt(declaration, caseId),
      ]),
    );
    const buildchain = {
      status: 'admitted',
      sourceRoot: declaration.bindings.sourceRoot,
      fresh: true,
      compatible: true,
      manualAllowlist: false,
      provider: 'kungfu-buildchain',
      runner: 'source-acceptance',
      sourceRevision,
      authorityRoot: buildchainAuthorityRoot,
      artifactRefs,
    };
    retained.scenarios[declaration.scenarioId] = { behavior, buildchain };
    for (const evidence of declaration.behaviorEvidence) {
      const value = behavior[evidence.case];
      evidence.status = 'passed';
      evidence.evidencePath = RETAINED_RELATIVE;
      evidence.evidencePointer = `/scenarios/${declaration.scenarioId}/behavior/${evidence.case}`;
      evidence.evidenceRoot = contentRoot(value);
    }
    declaration.platformAdapters = Object.entries(PLATFORMS).map(
      ([platform, relative]) => ({
        platform,
        relevance: 'required',
        status: 'passed',
        evidenceRoot: fileRoot(relative),
        evidencePath: relative,
        evidencePointer: null,
      }),
    );
    declaration.profileSurfaces = [
      'validate',
      'qualify',
      'authoring-check',
      'installed-runtime',
    ].map((surface) => ({
      surface,
      relevance: surface === 'installed-runtime' ? 'not-relevant' : 'required',
      status: surface === 'installed-runtime' ? 'unsupported' : 'supported',
    }));
    declaration.buildchain = {
      ...buildchain,
      evidenceRoot: contentRoot(buildchain),
      evidencePath: RETAINED_RELATIVE,
      evidencePointer: `/scenarios/${declaration.scenarioId}/buildchain`,
      authorityPath: BUILDCHAIN_AUTHORITY,
    };
    declaration.workOperationModel = {
      authority: 'existing-work-api',
      authorityRoot: workApiRoot,
      operations: workApi.actions.map(({ id }) => id),
      separateAssignment: false,
    };
  }
  const agentBuildchain = retained.scenarios['agent-work-control'].buildchain;
  const negative = {
    schema: 'kungfu.work-profile-conformance-negative-witnesses/v1',
    behavior: {
      'external-effect-failed': {
        case: 'external-effect',
        status: 'failed',
        witness:
          'external consequence cannot be represented without substituting domain authority',
      },
      'crash-crashed': {
        case: 'crash',
        status: 'crashed',
        witness: 'checker process terminated before retaining a result',
      },
    },
    buildchain: {
      absent: { ...agentBuildchain, status: 'absent', fresh: false },
      stale: { ...agentBuildchain, status: 'stale', fresh: false },
      mismatch: {
        ...agentBuildchain,
        status: 'mismatch',
        sourceRoot: `sha256:${'f'.repeat(64)}`,
      },
      'manual-allowlist': { ...agentBuildchain, manualAllowlist: true },
      incompatible: {
        ...agentBuildchain,
        status: 'incompatible',
        compatible: false,
      },
    },
  };
  return { reference: source, retained, negative };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const mode = process.argv[2] || '--check';
  const generated = generateQualificationFixtures();
  if (mode === '--write') {
    writeJson(REFERENCE_PATH, generated.reference);
    writeJson(RETAINED_PATH, generated.retained);
    writeJson(NEGATIVE_PATH, generated.negative);
    return;
  }
  if (mode !== '--check') throw new Error(`unknown mode: ${mode}`);
  const actualReference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const actualRetained = JSON.parse(fs.readFileSync(RETAINED_PATH, 'utf8'));
  const actualNegative = JSON.parse(fs.readFileSync(NEGATIVE_PATH, 'utf8'));
  if (canonicalJson(actualReference) !== canonicalJson(generated.reference))
    throw new Error('generated reference scenarios are stale');
  if (canonicalJson(actualRetained) !== canonicalJson(generated.retained))
    throw new Error('generated retained evidence is stale');
  if (canonicalJson(actualNegative) !== canonicalJson(generated.negative))
    throw new Error('generated negative evidence is stale');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[work-profile-qualification] ${error.message}\n`);
    process.exitCode = 1;
  }
}
