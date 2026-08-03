// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkReferenceQualification,
  contentRoot,
  evaluateConformance,
  validateResult,
} from './work-profile-conformance.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const SCRIPT = path.join(
  ROOT,
  'framework/work-profile-conformance/work-profile-conformance.mjs',
);
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'framework/work-profile-conformance/qualification/reference-scenarios.json',
    ),
    'utf8',
  ),
);
const clone = (value) => structuredClone(value);
const agentDeclaration = () => clone(FIXTURE.scenarios[0].declaration);
const NEGATIVE_PATH =
  'framework/work-profile-conformance/qualification/negative-witnesses.json';
const NEGATIVE = JSON.parse(
  fs.readFileSync(path.join(ROOT, NEGATIVE_PATH), 'utf8'),
);
const bindPointer = (coordinate, pointer, value) => {
  coordinate.evidencePath = NEGATIVE_PATH;
  coordinate.evidencePointer = pointer;
  coordinate.evidenceRoot = contentRoot(value);
};

test('qualifies agent, calendar, and non-agent reference scenarios', () => {
  const qualification = checkReferenceQualification();
  assert.equal(qualification.status, 'passed');
  assert.deepEqual(
    qualification.scenarios.map(({ scenarioId, verdict }) => ({
      scenarioId,
      verdict,
    })),
    [
      { scenarioId: 'agent-work-control', verdict: 'compatible' },
      {
        scenarioId: 'week-day-action',
        verdict: 'compatible-with-constraints',
      },
      { scenarioId: 'course-production', verdict: 'compatible' },
    ],
  );
});

test('returns a versioned, rooted, schema-valid compatible result', () => {
  const result = evaluateConformance(agentDeclaration());
  assert.equal(result.schema, 'kungfu.work-profile-conformance-result/v1');
  assert.equal(result.verdict, 'compatible');
  assert.match(result.declarationRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.conformanceRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.lifecycleMutation, false);
  assert.deepEqual(validateResult(result), { ok: true, errors: [] });
});

test('projects one conformance root across every supported required Profile surface', () => {
  const result = evaluateConformance(agentDeclaration());
  assert.deepEqual(Object.keys(result.surfaceRoots), [
    'authoring-check',
    'installed-runtime',
    'qualify',
    'validate',
  ]);
  assert.deepEqual(
    new Set(Object.values(result.surfaceRoots)),
    new Set([result.conformanceRoot]),
  );
});

test('public validate and qualify surface invocations return the same root', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-conformance-'),
  );
  const declarationPath = path.join(temporary, 'declaration.json');
  fs.writeFileSync(declarationPath, JSON.stringify(agentDeclaration()));
  const invoke = (surface) => {
    const run = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--declaration',
        declarationPath,
        '--surface',
        surface,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const validated = invoke('validate');
  const qualified = invoke('qualify');
  assert.equal(validated.conformanceRoot, qualified.conformanceRoot);
  assert.equal(validated.declarationRoot, qualified.declarationRoot);
});

test('fails closed as profile-invalid for malformed roots and duplicate evidence', () => {
  const malformed = agentDeclaration();
  malformed.bindings.actionGeometryRoot = 'not-a-root';
  assert.equal(evaluateConformance(malformed).verdict, 'profile-invalid');

  const duplicate = agentDeclaration();
  duplicate.behaviorEvidence.push(clone(duplicate.behaviorEvidence[0]));
  const result = evaluateConformance(duplicate);
  assert.equal(result.verdict, 'profile-invalid');
  const diagnostic = result.diagnostics.find(
    (item) => item.code === 'behavior-repeat-duplicate',
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.violatedInvariant, diagnostic.code);
  assert.deepEqual(diagnostic.evidenceCoordinate, {
    evidenceRoot: result.declarationRoot,
    evidencePath: null,
    evidencePointer: null,
  });
  assert.deepEqual(validateResult(result), { ok: true, errors: [] });
});

test('cold source validation remains schema-enforcing without Ajv', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-conformance-cold-'),
  );
  const declaration = agentDeclaration();
  declaration.unregisteredAuthority = true;
  const declarationPath = path.join(temporary, 'malformed.json');
  fs.writeFileSync(declarationPath, JSON.stringify(declaration));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--declaration', declarationPath, '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, KUNGFU_READONLY_NO_AJV: '1' },
    },
  );
  assert.equal(run.status, 2, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.verdict, 'profile-invalid');
  assert.ok(
    result.diagnostics.some(
      ({ code }) => code === 'declaration-schema-additionalProperties',
    ),
  );
});

test('fails closed when retained evidence is missing or root-mismatched', () => {
  const mismatched = agentDeclaration();
  mismatched.behaviorEvidence[0].evidenceRoot = `sha256:${'e'.repeat(64)}`;
  const mismatchResult = evaluateConformance(mismatched);
  assert.equal(mismatchResult.verdict, 'profile-invalid');
  assert.ok(
    mismatchResult.diagnostics.some(
      (item) => item.code === 'behavior-repeat-evidence-mismatch',
    ),
  );

  const missing = agentDeclaration();
  missing.behaviorEvidence[0].evidencePath =
    'framework/work-profile-conformance/qualification/not-present.json';
  const missingResult = evaluateConformance(missing);
  assert.equal(missingResult.verdict, 'unqualified');
  assert.ok(
    missingResult.diagnostics.some(
      (item) => item.code === 'behavior-repeat-evidence-missing',
    ),
  );
});

test('rejects forged authority roots and cross-domain evidence replay', () => {
  const forged = agentDeclaration();
  forged.bindings.domainProfileRoot = `sha256:${'9'.repeat(64)}`;
  forged.bindings.roleSchemaRoots.fact = `sha256:${'8'.repeat(64)}`;
  forged.humanAuthority.domainIdentity.authorityRoot = `sha256:${'7'.repeat(64)}`;
  const forgedResult = evaluateConformance(forged);
  assert.equal(forgedResult.verdict, 'profile-invalid');
  assert.ok(
    forgedResult.diagnostics.some(
      ({ code }) => code === 'binding-domainProfileRoot-evidence-mismatch',
    ),
  );

  const replay = agentDeclaration();
  const week = FIXTURE.scenarios.find(
    ({ declaration }) => declaration.scenarioId === 'week-day-action',
  ).declaration;
  for (const evidence of replay.behaviorEvidence) {
    const source = week.behaviorEvidence.find(
      ({ case: caseId }) => caseId === evidence.case,
    );
    Object.assign(evidence, source);
  }
  const replayResult = evaluateConformance(replay);
  assert.equal(replayResult.verdict, 'profile-invalid');
  assert.ok(
    replayResult.diagnostics.some(({ code }) =>
      code.endsWith('-evidence-semantic-mismatch'),
    ),
  );
});

test('keeps missing human semantics unqualified instead of machine-inferred', () => {
  const declaration = agentDeclaration();
  declaration.humanAuthority.successMeaning = {
    status: 'missing',
    statement: null,
    authorityRoot: null,
  };
  const result = evaluateConformance(declaration);
  assert.equal(result.verdict, 'unqualified');
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === 'human-authority-successMeaning-missing',
    ),
  );
});

test('distinguishes failed generic semantics from absent qualification evidence', () => {
  const incompatible = agentDeclaration();
  const externalEffect = incompatible.behaviorEvidence.find(
    ({ case: id }) => id === 'external-effect',
  );
  externalEffect.status = 'failed';
  bindPointer(
    externalEffect,
    '/behavior/external-effect-failed',
    NEGATIVE.behavior['external-effect-failed'],
  );
  assert.equal(
    evaluateConformance(incompatible).verdict,
    'scenario-incompatible',
  );

  const unqualified = agentDeclaration();
  const crash = unqualified.behaviorEvidence.find(
    ({ case: id }) => id === 'crash',
  );
  crash.status = 'crashed';
  bindPointer(
    crash,
    '/behavior/crash-crashed',
    NEGATIVE.behavior['crash-crashed'],
  );
  assert.equal(evaluateConformance(unqualified).verdict, 'unqualified');
});

test('blocks every unsupported Buildchain admission mode without an allowlist escape', () => {
  const absent = agentDeclaration();
  absent.buildchain.status = 'absent';
  absent.buildchain.fresh = false;
  bindPointer(
    absent.buildchain,
    '/buildchain/absent',
    NEGATIVE.buildchain.absent,
  );
  assert.equal(evaluateConformance(absent).verdict, 'unqualified');

  const stale = agentDeclaration();
  stale.buildchain.status = 'stale';
  stale.buildchain.fresh = false;
  bindPointer(stale.buildchain, '/buildchain/stale', NEGATIVE.buildchain.stale);
  assert.equal(evaluateConformance(stale).verdict, 'unqualified');

  const mismatch = agentDeclaration();
  mismatch.buildchain.status = 'mismatch';
  mismatch.buildchain.sourceRoot = `sha256:${'f'.repeat(64)}`;
  bindPointer(
    mismatch.buildchain,
    '/buildchain/mismatch',
    NEGATIVE.buildchain.mismatch,
  );
  assert.equal(evaluateConformance(mismatch).verdict, 'profile-invalid');

  const allowlisted = agentDeclaration();
  allowlisted.buildchain.manualAllowlist = true;
  bindPointer(
    allowlisted.buildchain,
    '/buildchain/manual-allowlist',
    NEGATIVE.buildchain['manual-allowlist'],
  );
  assert.equal(evaluateConformance(allowlisted).verdict, 'profile-invalid');

  const incompatible = agentDeclaration();
  incompatible.buildchain.status = 'incompatible';
  incompatible.buildchain.compatible = false;
  bindPointer(
    incompatible.buildchain,
    '/buildchain/incompatible',
    NEGATIVE.buildchain.incompatible,
  );
  assert.equal(
    evaluateConformance(incompatible).verdict,
    'scenario-incompatible',
  );

  const artifactMismatch = agentDeclaration();
  artifactMismatch.buildchain.artifactRefs[0].evidenceRoot = `sha256:${'f'.repeat(64)}`;
  const artifactResult = evaluateConformance(artifactMismatch);
  assert.equal(artifactResult.verdict, 'profile-invalid');
  assert.ok(
    artifactResult.diagnostics.some(
      ({ code }) => code === 'buildchain-evidence-semantic-mismatch',
    ),
  );
});

test('requires explicit relevant adapter and surface support', () => {
  const adapter = agentDeclaration();
  const rust = adapter.platformAdapters.find(
    ({ platform }) => platform === 'rust',
  );
  rust.status = 'unsupported';
  rust.evidenceRoot = null;
  assert.equal(evaluateConformance(adapter).verdict, 'unqualified');

  const surface = agentDeclaration();
  surface.profileSurfaces.find(({ surface: id }) => id === 'qualify').status =
    'unsupported';
  assert.equal(evaluateConformance(surface).verdict, 'unqualified');

  const omittedPlatform = agentDeclaration();
  omittedPlatform.platformAdapters = omittedPlatform.platformAdapters.filter(
    ({ platform }) => platform !== 'rust',
  );
  assert.equal(evaluateConformance(omittedPlatform).verdict, 'profile-invalid');

  const omittedSurface = agentDeclaration();
  omittedSurface.profileSurfaces = omittedSurface.profileSurfaces.filter(
    ({ surface: id }) => id !== 'qualify',
  );
  assert.equal(evaluateConformance(omittedSurface).verdict, 'profile-invalid');
});

test('generated fault receipts bind exact identity and idempotence semantics', () => {
  const retained = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'framework/work-profile-conformance/qualification/retained-witnesses.json',
      ),
      'utf8',
    ),
  );
  for (const [scenarioId, scenario] of Object.entries(retained.scenarios)) {
    const roots = new Set();
    for (const [caseId, receipt] of Object.entries(scenario.behavior)) {
      assert.equal(receipt.scenarioId, scenarioId);
      assert.equal(receipt.case, caseId);
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.output.identityRoot, receipt.identityRoot);
      assert.equal(receipt.output.resultIdentityRoot, receipt.identityRoot);
      assert.equal(receipt.output.duplicateAuthority, false);
      assert.equal(receipt.output.lifecycleFork, false);
      assert.equal(receipt.output.idempotencyKey, receipt.input.idempotencyKey);
      roots.add(receipt.identityRoot);
    }
    assert.equal(roots.size, 1);
  }
});

test('rejects Core forks, parallel authority, and separate Assignment closure', () => {
  for (const mutate of [
    (value) => {
      value.reuse.domainSpecificCoreFork = true;
    },
    (value) => {
      value.reuse.parallelAuthority = true;
    },
    (value) => {
      value.workOperationModel.separateAssignment = true;
    },
  ]) {
    const declaration = agentDeclaration();
    mutate(declaration);
    assert.equal(
      evaluateConformance(declaration).verdict,
      'scenario-incompatible',
    );
  }
});
