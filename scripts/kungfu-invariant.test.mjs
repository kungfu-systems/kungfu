// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { optionalAjv2020 } from './readonly-source-toolchain.mjs';

import { findBin } from '../tests/fixtures/_harness.mjs';
import {
  canonicalJson,
  checkEvolution,
  checkerDiagnosticTail,
  commandFailureDiagnostic,
  createEvidenceEnvelope,
  createPassport,
  digest,
  evaluateExitMigrationReleaseClaims,
  qualifyEpisodeObject,
  resolveCheckerCommand,
  resolveCheckerInvocation,
  sourceIdentityFromEvidence,
  synchronizeRegistryRoots,
  timeoutTerminationPlan,
  validateRegistry,
  verifyEpisodeObjectReceipt,
  verifyInvariants,
  verifyPassport,
} from './kungfu-invariant.mjs';
import { factKernelNativeInvocation } from './run-fact-kernel-native-tests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Ajv2020 = optionalAjv2020();
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const registry = readJson('framework/invariant/kungfu-invariant.registry.json');
const contract = readJson(
  'framework/invariant/kungfu-invariant-system.contract.json',
);

test('fixture binary discovery resolves executables through PATH', () => {
  const discovered = findBin([
    process.platform === 'win32' ? 'node.exe' : 'node',
  ]);
  assert.ok(discovered);
  assert.equal(fs.realpathSync(discovered), fs.realpathSync(process.execPath));
});

function qualificationSubject(overrides = {}) {
  const evidence = Object.fromEntries(
    [
      'manifest_records',
      'manifest_integrity',
      'causal_closure',
      'content',
      'frames',
      'schemas',
      'projection',
    ].map((name) => [name, { state: 'verified', issue_codes: [] }]),
  );
  const names = [
    'inspect',
    'fsck',
    'export_evidence',
    'plan_repair',
    'rebuild_projection',
    'append',
    'replay',
    'depend_on',
  ];
  return {
    schema: 'kungfu.episode.qualification/v1',
    policy_source: 'cpp-typed-fold-fsck',
    episode_id: 42,
    lifecycle: 'ended',
    status: 'ok',
    evidence,
    issues: [],
    capabilities: names.map((name) => ({
      name,
      safe: true,
      requires: ['manifest_integrity'],
      blocked_by: [],
    })),
    safe_capabilities: names,
    contractions: [],
    repair_prerequisites: [],
    ...overrides,
  };
}

function cleanSource() {
  return { revision: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false };
}

function releaseOptions(overrides = {}) {
  return {
    releaseArtifacts: [
      {
        name: 'kungfu-cli-darwin-arm64.tar.gz',
        digest:
          'sha256:8c0fcb6ec811c03c11be56b6d10fdd7cea5aed50657bc50979cfcdc805fd5cd3',
      },
    ],
    targetPlatforms: ['darwin-arm64'],
    ...overrides,
  };
}

function completeEvidence() {
  const evidence = [];
  for (const invariant of registry.invariants.filter(
    (item) => item.release.required,
  )) {
    for (const level of invariant.release.levels) {
      const checker = registry.checkers.find(
        (item) =>
          invariant.checkerIds.includes(item.id) && item.level === level,
      );
      assert.ok(checker, `${invariant.id} ${level}`);
      for (const platform of invariant.release.platforms) {
        evidence.push(
          createEvidenceEnvelope({
            invariant,
            checker,
            verdict: 'verified',
            source: cleanSource(),
            profile: 'release-candidate',
            stdout: `${invariant.id}:${level}:${platform}:verified`,
            currentPlatformId: platform,
            exitCode: 0,
            observedAt: '2026-07-20T00:00:00.000Z',
          }),
        );
      }
    }
  }
  return evidence;
}

test('checker command resolution uses the native Windows shifu launcher', () => {
  assert.equal(resolveCheckerCommand('./shifu', 'win32'), '.\\shifu.cmd');
  assert.equal(resolveCheckerCommand('./shifu', 'darwin'), './shifu');
  assert.equal(resolveCheckerCommand('node', 'win32'), 'node');
});

test('checker diagnostics prefer stderr, remove control codes, and redact the repository root', () => {
  assert.equal(
    checkerDiagnosticTail(
      'ignored stdout',
      `\u001b[31m${ROOT}/framework/core failed\r\n`,
      ROOT,
    ),
    '<repo>/framework/core failed',
  );
});

test('checker timeout terminates the complete Windows process tree', () => {
  assert.deepEqual(timeoutTerminationPlan(4321, 'win32'), {
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
  });
  assert.equal(timeoutTerminationPlan(4321, 'linux'), null);
  assert.equal(timeoutTerminationPlan(undefined, 'win32'), null);
});

test('checker failures expose bounded stdout and stderr diagnostics', () => {
  const rendered = commandFailureDiagnostic(
    'fact-native-characterization',
    {
      code: 2,
      signal: null,
      timedOut: false,
      stdout: 'pytest output',
      stderr: `discard-${'x'.repeat(20)}-usage error`,
    },
    16,
  );
  assert.match(rendered, /exit=2 signal=none timedOut=false/u);
  assert.match(rendered, /pytest output/u);
  assert.doesNotMatch(rendered, /discard/u);
  assert.match(rendered, /usage error/u);
});

test('Fact native harness preserves its source qualification boundary on Windows', () => {
  const invocation = factKernelNativeInvocation({
    platform: 'win32',
    baseEnv: { PATH: 'existing-path', SENTINEL: 'preserved' },
  });
  assert.equal(invocation.command, 'uv');
  assert.deepEqual(invocation.args.slice(0, 6), [
    'run',
    '--project',
    path.join(ROOT, 'framework', 'core'),
    '--frozen',
    'pytest',
    '-vv',
  ]);
  assert.match(invocation.args.at(-2), /test_agent_work_profile_native\.py$/u);
  assert.match(
    invocation.args.at(-1),
    /test_fact_kernel_characterization\.py$/u,
  );
  assert.equal(invocation.env.SENTINEL, 'preserved');
  assert.equal(invocation.env.KUNGFU_ALLOW_FOREIGN_RUNTIME, '1');
  assert.equal(invocation.env.PYTHONUNBUFFERED, '1');
  assert.equal(invocation.env.PYTHONPATH.split(';').length, 3);
  assert.match(invocation.env.PATH, /framework[/\\]core[/\\]build/u);
  assert.equal(invocation.shell, true);
});

test('Windows invariant checker delegates Fact native execution to the shared harness', () => {
  const checker = registry.checkers.find(
    (item) => item.id === 'fact-native-characterization',
  );
  const invocation = resolveCheckerInvocation(checker, 'win32', {
    PATH: 'existing-path',
    SENTINEL: 'preserved',
  });
  assert.equal(invocation.command, 'uv');
  assert.match(invocation.args.at(-2), /test_agent_work_profile_native\.py$/u);
  assert.match(
    invocation.args.at(-1),
    /test_fact_kernel_characterization\.py$/u,
  );
  assert.equal(invocation.env.SENTINEL, 'preserved');
  assert.equal(invocation.env.KUNGFU_ALLOW_FOREIGN_RUNTIME, '1');
  assert.equal(invocation.env.PYTHONUNBUFFERED, '1');
  assert.equal(invocation.shell, true);
});

test('Fact characterization fixtures use an explicit cross-platform encoding', () => {
  const source = fs.readFileSync(
    path.join(
      ROOT,
      'framework/core/tests/python/test_fact_kernel_characterization.py',
    ),
    'utf8',
  );
  assert.equal(source.match(/\.read_text\(encoding="utf-8"\)/gu)?.length, 2);
  assert.doesNotMatch(source, /\.read_text\(\)/u);
});

test('meta-contract freezes orthogonal stability, maturity, verdict, and layer vocabularies', () => {
  assert.deepEqual(contract.vocabulary.stability, [
    'constitutional',
    'protocol',
    'profile',
    'policy',
  ]);
  assert.deepEqual(contract.vocabulary.maturity, [
    'declared',
    'falsifiable',
    'independently-conformant',
    'qualified',
    'release-enforced',
    'battle-tested',
  ]);
  assert.deepEqual(contract.vocabulary.verdict, [
    'verified',
    'falsified',
    'unqualified',
    'not-applicable',
  ]);
  assert.deepEqual(contract.vocabulary.layers, [
    'source',
    'native',
    'runtime',
    'object',
    'release',
  ]);
  assert.match(
    contract.authorityBoundary.registryRule,
    /authoritative domain contracts/u,
  );
  assert.match(
    contract.authorityBoundary.admissionSeparation,
    /neither substitutes/iu,
  );
});

test('registry validates, has no root drift, and binds strong invariants to models and refinements', () => {
  assert.deepEqual(validateRegistry(registry), []);
  assert.equal(
    canonicalJson(synchronizeRegistryRoots(registry)),
    canonicalJson(registry),
  );
  assert.ok(registry.invariants.some((item) => item.domain === 'fact'));
  assert.ok(registry.invariants.some((item) => item.domain === 'episode'));
  for (const invariant of registry.invariants.filter((item) =>
    ['constitutional', 'protocol'].includes(item.stability),
  )) {
    assert.ok(invariant.model, invariant.id);
    assert.ok(invariant.refinement, invariant.id);
  }
});

test('the public source runner discovers and verifies both domains without native prerequisites', async () => {
  const result = await verifyInvariants({
    levels: ['source'],
    observedAt: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(result.summary.verdict, 'verified');
  assert.equal(result.evidence.length, registry.invariants.length);
  assert.deepEqual(
    new Set(result.evidence.map((item) => item.invariant.domain)),
    new Set(['fact', 'episode']),
  );
  assert.ok(result.evidence.every((item) => item.verdict === 'verified'));
});

test('source drift, unknown checker, and missing strong-model bindings fail closed', () => {
  const stale = structuredClone(registry);
  stale.invariants[0].source.root = `sha256:${'0'.repeat(64)}`;
  assert.notEqual(
    canonicalJson(synchronizeRegistryRoots(stale)),
    canonicalJson(stale),
  );
  const unknown = structuredClone(registry);
  unknown.invariants[0].checkerIds[0] = 'missing-checker';
  assert.ok(
    validateRegistry(unknown).some((item) => item.includes('unknown checker')),
  );
  const modelLess = structuredClone(registry);
  Reflect.deleteProperty(
    modelLess.invariants.find((item) => item.stability === 'constitutional'),
    'model',
  );
  assert.ok(
    validateRegistry(modelLess).some((item) => item.includes('requires model')),
  );
});

test('implementation passport verifies a complete three-platform matrix and rejects omission, falsification, staleness, and tamper', () => {
  const evidence = completeEvidence();
  const passport = createPassport(evidence, {
    source: cleanSource(),
    observedAt: '2026-07-20T00:00:00.000Z',
    ...releaseOptions(),
  });
  assert.equal(passport.verdict, 'verified');
  assert.equal(passport.coverage.complete, true);
  assert.deepEqual(
    verifyPassport(passport, evidence, registry, {
      checkRevision: false,
      ...releaseOptions(),
    }),
    [],
  );

  const omittedEvidence = evidence.slice(1);
  const omitted = createPassport(omittedEvidence, {
    source: cleanSource(),
    observedAt: '2026-07-20T00:00:00.000Z',
    ...releaseOptions(),
  });
  assert.equal(omitted.verdict, 'unqualified');
  assert.ok(omitted.coverage.missing.length > 0);

  const falsifiedEvidence = structuredClone(evidence);
  const firstInvariant = registry.invariants.find(
    (item) => item.id === falsifiedEvidence[0].invariant.id,
  );
  const firstChecker = registry.checkers.find(
    (item) => item.id === falsifiedEvidence[0].checker.id,
  );
  falsifiedEvidence[0] = createEvidenceEnvelope({
    invariant: firstInvariant,
    checker: firstChecker,
    verdict: 'falsified',
    source: cleanSource(),
    profile: 'release-candidate',
    currentPlatformId: falsifiedEvidence[0].environment.platformId,
    exitCode: 1,
    observedAt: '2026-07-20T00:00:00.000Z',
  });
  const falsified = createPassport(falsifiedEvidence, {
    source: cleanSource(),
    observedAt: '2026-07-20T00:00:00.000Z',
    ...releaseOptions(),
  });
  assert.equal(falsified.verdict, 'falsified');

  const tampered = structuredClone(passport);
  tampered.coverage.verified -= 1;
  assert.ok(
    verifyPassport(tampered, evidence, registry, {
      checkRevision: false,
    }).includes('passport-root-mismatch'),
  );

  const stale = structuredClone(evidence);
  stale[0].source.subjectRoot = `sha256:${'0'.repeat(64)}`;
  const stalePassport = createPassport(stale, {
    source: cleanSource(),
    observedAt: '2026-07-20T00:00:00.000Z',
    ...releaseOptions(),
  });
  assert.ok(
    verifyPassport(stalePassport, stale, registry, {
      checkRevision: false,
      ...releaseOptions(),
    }).some((item) => item.includes('stale-source')),
  );
});

test('release evidence aggregation preserves the built source identity and rejects mixed sources', () => {
  const evidence = completeEvidence();
  assert.deepEqual(sourceIdentityFromEvidence(evidence), cleanSource());
  const mixed = structuredClone(evidence);
  mixed[0].source.revision = 'c'.repeat(40);
  assert.deepEqual(sourceIdentityFromEvidence(mixed), {
    ...cleanSource(),
    revision: 'c'.repeat(40),
    dirty: true,
  });
  const passport = createPassport(mixed, {
    source: sourceIdentityFromEvidence(mixed),
    ...releaseOptions(),
  });
  assert.equal(passport.verdict, 'unqualified');
  assert.ok(passport.diagnostics.some((item) => item.code === 'dirty-source'));
});

test('Exit migration release claims bind exact installed witnesses and fail closed on every declared downgrade', () => {
  const exact = evaluateExitMigrationReleaseClaims(releaseOptions());
  assert.equal(exact.verdict, 'verified');
  assert.equal(exact.freshness.current, true);
  assert.deepEqual(exact.nextActions, []);
  assert.deepEqual(exact.applicability.targetPlatforms, ['darwin-arm64']);
  assert.equal(
    exact.sourceWitnesses.installedVerifierRoot,
    'sha256:5850fd3fd6e559871f7ba10973f6db78ac50e738f327169e2457b67628396151',
  );

  const missing = evaluateExitMigrationReleaseClaims();
  assert.equal(missing.verdict, 'unqualified');
  assert.ok(
    missing.diagnostics.some(
      (item) => item.code === 'release-artifact-missing',
    ),
  );
  assert.ok(
    missing.nextActions.some((item) =>
      item.includes('installed-product qualification'),
    ),
  );

  const tamperedReport = readJson(
    'docs/qualification/evidence/exit-clean-runtime/520a61af87/report.json',
  );
  tamperedReport.status = 'tampered';
  const tampered = evaluateExitMigrationReleaseClaims({
    ...releaseOptions(),
    cleanRuntime: tamperedReport,
  });
  assert.ok(
    tampered.diagnostics.some(
      (item) => item.code === 'release-evidence-stale-or-tampered',
    ),
  );

  const thin = evaluateExitMigrationReleaseClaims(
    releaseOptions({ releaseProfile: 'thin' }),
  );
  assert.ok(
    thin.diagnostics.some(
      (item) => item.code === 'release-profile-unqualified',
    ),
  );

  const wrongPlatform = evaluateExitMigrationReleaseClaims({
    releaseArtifacts: [
      {
        name: 'kungfu-cli-linux-x64.tar.gz',
        digest:
          'sha256:8c0fcb6ec811c03c11be56b6d10fdd7cea5aed50657bc50979cfcdc805fd5cd3',
      },
    ],
  });
  assert.ok(
    wrongPlatform.diagnostics.some(
      (item) => item.code === 'release-platform-unqualified',
    ),
  );

  const providerUnavailable = evaluateExitMigrationReleaseClaims(
    releaseOptions({ availableProviders: ['content-addressed-file'] }),
  );
  assert.ok(
    providerUnavailable.diagnostics.some(
      (item) => item.code === 'release-provider-unavailable',
    ),
  );

  const contractWithStaleSource = structuredClone(contract);
  contractWithStaleSource.releaseGate.exitMigrationClaims.evidence.cleanRuntime.sourceRevision =
    'deadbeef00';
  const stale = evaluateExitMigrationReleaseClaims({
    ...releaseOptions(),
    contract: contractWithStaleSource,
  });
  assert.ok(
    stale.diagnostics.some(
      (item) => item.code === 'release-evidence-source-unbound',
    ),
  );

  const adrDrift = evaluateExitMigrationReleaseClaims({
    ...releaseOptions(),
    adr: { decisionStatus: 'proposed', implementationStatus: 'staged' },
  });
  assert.ok(
    adrDrift.diagnostics.some(
      (item) => item.code === 'release-adr-status-drift',
    ),
  );
});

test('Episode object receipt is stable, separate from admission, and honest for sealed, open, damaged, and changed objects', () => {
  const subject = qualificationSubject();
  const first = qualifyEpisodeObject(subject, {
    observedAt: '2026-07-20T00:00:00.000Z',
  });
  const second = qualifyEpisodeObject(subject, {
    observedAt: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(first.verdict, 'verified');
  assert.equal(first.receiptKind, 'object-qualification');
  assert.equal(first.receiptRoot, second.receiptRoot);
  assert.deepEqual(verifyEpisodeObjectReceipt(first, subject), []);

  const open = qualifyEpisodeObject(
    qualificationSubject({ lifecycle: 'open' }),
    { observedAt: '2026-07-20T00:00:00.000Z' },
  );
  assert.equal(open.verdict, 'unqualified');
  assert.ok(open.blockers.some((item) => item.code === 'episode-not-sealed'));

  const damagedSubject = qualificationSubject({
    status: 'failed',
    evidence: {
      ...subject.evidence,
      causal_closure: { state: 'failed', issue_codes: ['causal-edge-missing'] },
    },
    issues: [
      {
        severity: 'error',
        code: 'causal-edge-missing',
        evidence: 'causal_closure',
        detail: {},
      },
    ],
  });
  const damaged = qualifyEpisodeObject(damagedSubject, {
    observedAt: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(damaged.verdict, 'falsified');

  const changed = structuredClone(subject);
  changed.safe_capabilities = changed.safe_capabilities.filter(
    (item) => item !== 'replay',
  );
  assert.ok(
    verifyEpisodeObjectReceipt(first, changed).includes('stale-subject'),
  );
});

test('successor gate rejects silent semantic change and requires model/refinement impact for strong invariants', () => {
  const baseline = structuredClone(registry);
  const current = structuredClone(registry);
  const target = current.invariants.find(
    (item) => item.stability === 'protocol',
  );
  const previous = baseline.invariants.find((item) => item.id === target.id);
  target.source.root = `sha256:${'c'.repeat(64)}`;
  assert.deepEqual(checkEvolution(baseline, current, []), [
    `${target.id}:semantic-change-without-successor`,
  ]);
  const successor = {
    schema: 'kungfu.invariant-successor/v1',
    predecessorId: target.id,
    predecessorSourceRoot: previous.source.root,
    successorId: target.id,
    successorSourceRoot: target.source.root,
    semanticDiff: ['fixture mutation'],
    historicalInterpretation:
      'Predecessor objects retain predecessor interpretation.',
    migration: 'No automatic migration.',
    rollback: 'Restore predecessor protocol for predecessor objects.',
    requalification: ['source', 'native', 'runtime'],
  };
  assert.deepEqual(checkEvolution(baseline, current, [successor]), [
    `${target.id}:strong-successor-impact-missing`,
  ]);
  successor.abstractModelImpact =
    'No state set change; one transition guard changes.';
  successor.refinementImpact = 'All native and runtime refinements rerun.';
  assert.deepEqual(checkEvolution(baseline, current, [successor]), []);
});

test('schemas reject unknown verdicts and tampered receipt roots', () => {
  if (Ajv2020) {
    const schema = readJson(
      'framework/invariant/schema/invariant-evidence-v1.schema.json',
    );
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema);
    const sample = completeEvidence()[0];
    sample.verdict = 'passed';
    assert.equal(validate(sample), false);
  }
  const receipt = qualifyEpisodeObject(qualificationSubject(), {
    observedAt: '2026-07-20T00:00:00.000Z',
  });
  receipt.qualifiedCapabilities.pop();
  assert.ok(
    verifyEpisodeObjectReceipt(receipt, qualificationSubject()).includes(
      'receipt-root-mismatch',
    ),
  );
  assert.match(
    digest(readJson('tests/fixtures/invariant-system/cases.json')),
    /^sha256:[0-9a-f]{64}$/u,
  );
});
