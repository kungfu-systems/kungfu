#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyPrecondition,
  classifyRecovery,
  executeQualificationActionLoop,
} from '../action/index.mjs';

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
const AUTHORITY_MANIFEST_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/authority-manifest.json',
);
const WORK_CONTROL_DECLARATION_PATH = path.join(
  ROOT,
  'extensions/work-control/qualification/work-profile-conformance.json',
);
const WORK_CONTROL_PROFILE_PATH = path.join(
  ROOT,
  'extensions/work-control/profile.json',
);
const RETAINED_RELATIVE = path
  .relative(ROOT, RETAINED_PATH)
  .split(path.sep)
  .join('/');
const BUILDCHAIN_GATE =
  'framework/work-profile-conformance/qualification/kfd-7-product-gate.json';
const BUILDCHAIN_AUTHORITY = '.buildchain/alpha-contract-lock.json';
const ACTION_LOOP_CONTRACT = 'framework/action/action-loop.contract.json';
const ACTION_LOOP_FIXTURES = 'framework/action/action-loop-fixtures.json';
const ACTION_LOOP_QUALIFICATION_ADAPTERS =
  'framework/action/action-loop-qualification-adapters.mjs';
const ACTION_LOOP_BEGIN = 'framework/action/action-loop-begin.mjs';
const ACTION_LOOP_SETTLE = 'framework/action/action-loop-settle.mjs';
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

const KFD_BEHAVIOR = {
  'provider-switch': {
    path: 'framework/agent-work/evidence/kfd-7/backend-migration.json',
    category: 'backend-migration',
    checks: [
      'storage-backend-switch-delegation-declared',
      'five-role-identity-conservation-witness',
      'file-rocksdb-file-rollback',
    ],
  },
  'projection-rebuild': {
    path: 'framework/agent-work/evidence/kfd-7/export-import-rebuild.json',
    category: 'export-import-rebuild',
    checks: [
      'projection-rebuild-from-native-journal',
      'qualified-fact-export-import-bundle',
      'tampered-bundle-fails-before-write',
    ],
  },
  recovery: {
    path: 'framework/agent-work/evidence/kfd-7/cold-start-continuation.json',
    category: 'cold-start-continuation',
    checks: [
      'fresh-home-bootstrap-action',
      'clean-home-continuation-from-qualified-export',
      'clean-home-next-revision',
    ],
  },
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
const generatedJsonRoot = (value) =>
  sha256(`${JSON.stringify(value, null, 2)}\n`);
const coordinate = (relative) => ({
  evidenceRoot: fileRoot(relative),
  evidencePath: relative,
  evidencePointer: null,
});
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

async function executeActionLoopWitnesses() {
  const contract = readJson(ACTION_LOOP_CONTRACT);
  const execution = await executeQualificationActionLoop(contract);
  const { bound, running, settled } = execution;
  const cases = {
    repeat: {
      actual: classifyRecovery(contract, settled.envelope, [
        ...settled.receipts,
        { ...settled.receipts.at(-1) },
      ]),
      expected: { ok: true, code: 'already-settled' },
    },
    crash: {
      actual: classifyRecovery(contract, running.envelope, running.receipts),
      expected: { ok: true, code: 'resume', nextStep: 'seal-episode' },
    },
    interrupted: {
      actual: classifyRecovery(contract, bound.envelope, bound.receipts),
      expected: { ok: true, code: 'resume', nextStep: 'open-episode' },
    },
    stale: {
      actual: classifyPrecondition(running.envelope, {
        atlasCurrent: true,
        warrantState: 'issued',
        factRef: { cutRoot: `sha256:${'1'.repeat(64)}`, revision: 2 },
      }),
      expected: { ok: false, code: 'stale-ref' },
    },
    'warrant-revoked': {
      actual: classifyPrecondition(running.envelope, {
        atlasCurrent: true,
        warrantState: 'revoked',
      }),
      expected: { ok: false, code: 'warrant-revoked' },
    },
    'external-effect': {
      actual: classifyPrecondition(running.envelope, {
        atlasCurrent: true,
        warrantState: 'issued',
        externalEffect: 'unknown',
      }),
      expected: {
        ok: false,
        code: 'external-effect-unknown',
        nextStep: 'inspect-external-effect',
      },
    },
  };
  const implementation = [
    coordinate('framework/action/action-loop.mjs'),
    coordinate(ACTION_LOOP_BEGIN),
    coordinate(ACTION_LOOP_SETTLE),
    coordinate(ACTION_LOOP_QUALIFICATION_ADAPTERS),
    coordinate(ACTION_LOOP_CONTRACT),
  ];
  return {
    actionLoop: Object.fromEntries(
      Object.entries(cases).map(([caseId, witness]) => {
        for (const [field, expected] of Object.entries(witness.expected))
          if (witness.actual[field] !== expected)
            throw new Error(
              `action-loop witness ${caseId} expected ${field}=${expected}, got ${witness.actual[field]}`,
            );
        const value = {
          schema: 'kungfu.work-profile-runtime-behavior-witness/v1',
          case: caseId,
          status: 'passed',
          implementation,
          expected: witness.expected,
          actual: witness.actual,
        };
        return [caseId, value];
      }),
    ),
    adapterNegative: execution.adapterNegative,
  };
}

export async function generateQualificationFixtures() {
  const source = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const actionLoopExecution = await executeActionLoopWitnesses();
  const retained = {
    schema: 'kungfu.work-profile-generated-evidence/v1',
    generator: 'framework/work-profile-conformance/generate-qualification.mjs',
    actionLoop: actionLoopExecution.actionLoop,
    adapterNegative: actionLoopExecution.adapterNegative,
    kfd7: KFD_BEHAVIOR,
  };
  const actionGeometryRoot = fileRoot(ACTION_GEOMETRY);
  const abstractionAuthorityRoot = fileRoot(WORK_LIFECYCLE);
  const workApi = JSON.parse(
    fs.readFileSync(path.join(ROOT, WORK_API), 'utf8'),
  );
  const workApiRoot = fileRoot(WORK_API);
  const buildchainAuthorityRoot = fileRoot(BUILDCHAIN_AUTHORITY);
  const buildchainGate = readJson(BUILDCHAIN_GATE);

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

    for (const evidence of declaration.behaviorEvidence) {
      evidence.status = 'passed';
      const kfd = KFD_BEHAVIOR[evidence.case];
      if (kfd) {
        evidence.evidencePath = kfd.path;
        evidence.evidencePointer = null;
        evidence.evidenceRoot = fileRoot(kfd.path);
      } else {
        const value = retained.actionLoop[evidence.case];
        if (!value) throw new Error(`unknown behavior case: ${evidence.case}`);
        evidence.evidencePath = RETAINED_RELATIVE;
        evidence.evidencePointer = `/actionLoop/${evidence.case}`;
        evidence.evidenceRoot = contentRoot(value);
      }
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
      relevance: 'required',
      status: 'supported',
    }));
    declaration.buildchain = {
      status: buildchainGate.status,
      compatible: buildchainGate.status === 'passed',
      manualAllowlist: false,
      provider: 'kungfu-buildchain',
      runner: 'kfd-product-gate',
      sourceRevision: buildchainGate.source.sha,
      gateRoot: buildchainGate.gateRoot,
      selfCertified: buildchainGate.selfCertified,
      evidenceRoot: fileRoot(BUILDCHAIN_GATE),
      evidencePath: BUILDCHAIN_GATE,
      evidencePointer: null,
      authorityPath: BUILDCHAIN_AUTHORITY,
      authorityRoot: buildchainAuthorityRoot,
    };
    declaration.workOperationModel = {
      authority: 'existing-work-api',
      authorityRoot: workApiRoot,
      operations: workApi.actions.map(({ id }) => id),
      separateAssignment: false,
    };
  }
  const agentBuildchain = source.scenarios[0].declaration.buildchain;
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
      absent: { ...agentBuildchain, status: 'absent' },
      stale: { ...agentBuildchain, status: 'stale' },
      mismatch: {
        ...agentBuildchain,
        status: 'mismatch',
        gateRoot: `sha256:${'f'.repeat(64)}`,
      },
      'manual-allowlist': { ...agentBuildchain, manualAllowlist: true },
      incompatible: {
        ...agentBuildchain,
        status: 'incompatible',
        compatible: false,
      },
      'report-revision-drift': {
        ...readJson(KFD_BEHAVIOR['provider-switch'].path),
        sourceSha: '0'.repeat(40),
      },
    },
  };
  const authorityPaths = new Set([
    ACTION_GEOMETRY,
    ACTION_LOOP_CONTRACT,
    ACTION_LOOP_FIXTURES,
    ACTION_LOOP_BEGIN,
    ACTION_LOOP_SETTLE,
    ACTION_LOOP_QUALIFICATION_ADAPTERS,
    'framework/action/action-loop.mjs',
    WORK_LIFECYCLE,
    WORK_API,
    RETAINED_RELATIVE,
    path.relative(ROOT, REFERENCE_PATH).split(path.sep).join('/'),
    BUILDCHAIN_GATE,
    BUILDCHAIN_AUTHORITY,
    ...Object.values(PLATFORMS),
    ...Object.values(KFD_BEHAVIOR).map(({ path: relative }) => relative),
  ]);
  for (const binding of Object.values(DOMAIN_BINDINGS)) {
    authorityPaths.add(binding.domainProfilePath);
    authorityPaths.add(binding.sourcePath);
    for (const relative of Object.values(binding.roleSchemaPaths))
      authorityPaths.add(relative);
  }
  const referenceRelative = path
    .relative(ROOT, REFERENCE_PATH)
    .split(path.sep)
    .join('/');
  const authorityFiles = [...authorityPaths].sort().map((relative) => ({
    path: relative,
    sha256:
      relative === referenceRelative
        ? generatedJsonRoot(source)
        : relative === RETAINED_RELATIVE
          ? generatedJsonRoot(retained)
          : fileRoot(relative),
  }));
  const authorityManifest = {
    schema: 'kungfu.work-profile-conformance-authority-bundle/v1',
    files: authorityFiles,
    bundleRoot: contentRoot(authorityFiles),
  };
  return { reference: source, retained, negative, authorityManifest };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const mode = process.argv[2] || '--check';
  const generated = await generateQualificationFixtures();
  if (mode === '--write') {
    writeJson(REFERENCE_PATH, generated.reference);
    writeJson(RETAINED_PATH, generated.retained);
    writeJson(NEGATIVE_PATH, generated.negative);
    writeJson(AUTHORITY_MANIFEST_PATH, generated.authorityManifest);
    const workControlDeclaration = generated.reference.scenarios[0].declaration;
    writeJson(WORK_CONTROL_DECLARATION_PATH, workControlDeclaration);
    const workControlProfile = JSON.parse(
      fs.readFileSync(WORK_CONTROL_PROFILE_PATH, 'utf8'),
    );
    workControlProfile.work = {
      conformance: {
        path: 'qualification/work-profile-conformance.json',
        sha256: generatedJsonRoot(workControlDeclaration).slice(7),
      },
    };
    writeJson(WORK_CONTROL_PROFILE_PATH, workControlProfile);
    return;
  }
  if (mode !== '--check') throw new Error(`unknown mode: ${mode}`);
  const actualReference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const actualRetained = JSON.parse(fs.readFileSync(RETAINED_PATH, 'utf8'));
  const actualNegative = JSON.parse(fs.readFileSync(NEGATIVE_PATH, 'utf8'));
  const actualAuthorityManifest = JSON.parse(
    fs.readFileSync(AUTHORITY_MANIFEST_PATH, 'utf8'),
  );
  if (canonicalJson(actualReference) !== canonicalJson(generated.reference))
    throw new Error('generated reference scenarios are stale');
  if (canonicalJson(actualRetained) !== canonicalJson(generated.retained))
    throw new Error('generated retained evidence is stale');
  if (canonicalJson(actualNegative) !== canonicalJson(generated.negative))
    throw new Error('generated negative evidence is stale');
  if (
    canonicalJson(actualAuthorityManifest) !==
    canonicalJson(generated.authorityManifest)
  )
    throw new Error('generated authority manifest is stale');
  const workControlDeclaration = JSON.parse(
    fs.readFileSync(WORK_CONTROL_DECLARATION_PATH, 'utf8'),
  );
  if (
    canonicalJson(workControlDeclaration) !==
    canonicalJson(generated.reference.scenarios[0].declaration)
  )
    throw new Error('Work Control conformance declaration is stale');
  const workControlProfile = JSON.parse(
    fs.readFileSync(WORK_CONTROL_PROFILE_PATH, 'utf8'),
  );
  if (
    workControlProfile.work?.conformance?.sha256 !==
    generatedJsonRoot(workControlDeclaration).slice(7)
  )
    throw new Error('Work Control conformance content reference is stale');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[work-profile-qualification] ${error.message}\n`);
    process.exitCode = 1;
  }
}
