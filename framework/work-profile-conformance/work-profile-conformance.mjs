#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DECLARATION_SCHEMA_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/schema/work-profile-conformance-declaration-v1.schema.json',
);
const RESULT_SCHEMA_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/schema/work-profile-conformance-result-v1.schema.json',
);
const QUALIFICATION_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/qualification/reference-scenarios.json',
);
const ACTION_GEOMETRY_PATH = path.join(
  ROOT,
  'framework/action/action-geometry.contract.json',
);
const WORK_LIFECYCLE_PATH = path.join(
  ROOT,
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
);

export const BEHAVIOR_CASES = [
  'repeat',
  'crash',
  'interrupted',
  'stale',
  'warrant-revoked',
  'provider-switch',
  'projection-rebuild',
  'external-effect',
  'recovery',
];

const INVALID = 'invalid';
const INCOMPATIBLE = 'incompatible';
const UNQUALIFIED = 'unqualified';
const CONSTRAINT = 'constraint';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (bytes) =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const contentRoot = (value) => sha256(canonicalJson(value));
const fileRoot = (file) => sha256(fs.readFileSync(file));

function resolveJsonPointer(value, pointer) {
  if (pointer === '') return value;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !(key in current))
      throw new Error(`evidence-pointer-missing: ${pointer}`);
    current = current[key];
  }
  return current;
}

function inspectEvidence(coordinate) {
  if (!coordinate.evidencePath || !coordinate.evidenceRoot)
    return { status: 'missing', value: null };
  const absolute = path.resolve(ROOT, coordinate.evidencePath);
  if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`))
    return { status: 'invalid-path', value: null };
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    return { status: 'missing', value: null };
  try {
    if (coordinate.evidencePointer) {
      const value = resolveJsonPointer(
        JSON.parse(fs.readFileSync(absolute, 'utf8')),
        coordinate.evidencePointer,
      );
      const actualRoot = contentRoot(value);
      return {
        status:
          actualRoot === coordinate.evidenceRoot ? 'verified' : 'mismatch',
        actualRoot,
        value,
      };
    }
    const actualRoot = fileRoot(absolute);
    return {
      status: actualRoot === coordinate.evidenceRoot ? 'verified' : 'mismatch',
      actualRoot,
      value: null,
    };
  } catch (error) {
    return { status: 'invalid', value: null, message: error.message };
  }
}

function retainEvidence(diagnostics, prefix, coordinate) {
  const retained = inspectEvidence(coordinate);
  if (retained.status === 'verified') return retained;
  diagnostics.push(
    diagnostic(
      `${prefix}-evidence-${retained.status}`,
      ['mismatch', 'invalid', 'invalid-path'].includes(retained.status)
        ? INVALID
        : UNQUALIFIED,
      retained.status === 'mismatch'
        ? `Retained evidence root mismatch: expected ${coordinate.evidenceRoot}, got ${retained.actualRoot}.`
        : `Retained evidence is ${retained.status}.`,
    ),
  );
  return retained;
}

function diagnostic(code, classification, message) {
  return { code, class: classification, message };
}

function check(id, status, evidenceRoot = null) {
  return { id, status, evidenceRoot };
}

function schemaValidator(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath));
}

function schemaDiagnostics(errors = []) {
  return errors.map((error) =>
    diagnostic(
      `declaration-schema-${error.keyword}`,
      INVALID,
      `${error.instancePath || '<root>'} ${error.message}`,
    ),
  );
}

function resultForInvalid(declaration, diagnostics) {
  const declarationRoot = contentRoot(declaration);
  const stable = {
    schema: 'kungfu.work-profile-conformance-result/v1',
    scenarioId:
      typeof declaration?.scenarioId === 'string'
        ? declaration.scenarioId
        : 'invalid-declaration',
    verdict: 'profile-invalid',
    declarationRoot,
    authorityBindings:
      declaration?.bindings && typeof declaration.bindings === 'object'
        ? declaration.bindings
        : {},
    machineChecks: [],
    humanAuthority:
      declaration?.humanAuthority &&
      typeof declaration.humanAuthority === 'object'
        ? declaration.humanAuthority
        : {},
    diagnostics: diagnostics.sort((a, b) => a.code.localeCompare(b.code)),
    constraints: Array.isArray(declaration?.constraints)
      ? declaration.constraints
      : [],
    residualRisk: Array.isArray(declaration?.residualRisk)
      ? declaration.residualRisk
      : [],
    lifecycleMutation: false,
  };
  const conformanceRoot = contentRoot(stable);
  return { ...stable, conformanceRoot, surfaceRoots: {} };
}

function verdictFor(diagnostics, constraints) {
  if (diagnostics.some((item) => item.class === INVALID))
    return 'profile-invalid';
  if (diagnostics.some((item) => item.class === INCOMPATIBLE))
    return 'scenario-incompatible';
  if (diagnostics.some((item) => item.class === UNQUALIFIED))
    return 'unqualified';
  if (
    constraints.length ||
    diagnostics.some((item) => item.class === CONSTRAINT)
  )
    return 'compatible-with-constraints';
  return 'compatible';
}

export function evaluateConformance(declaration) {
  const validate = schemaValidator(DECLARATION_SCHEMA_PATH);
  if (!validate(declaration))
    return resultForInvalid(declaration, schemaDiagnostics(validate.errors));

  const diagnostics = [];
  const checks = [];
  const declarationRoot = contentRoot(declaration);
  const expectedActionGeometryRoot = fileRoot(ACTION_GEOMETRY_PATH);
  const geometryMatches =
    declaration.bindings.actionGeometryRoot === expectedActionGeometryRoot;
  checks.push(
    check(
      'exact-action-geometry-root',
      geometryMatches ? 'passed' : 'failed',
      expectedActionGeometryRoot,
    ),
  );
  if (!geometryMatches)
    diagnostics.push(
      diagnostic(
        'action-geometry-root-mismatch',
        INVALID,
        'The declaration is not bound to the current generic Action Geometry authority.',
      ),
    );

  const expectedAbstractionAuthorityRoot = fileRoot(WORK_LIFECYCLE_PATH);
  const abstractionMatches =
    declaration.bindings.abstractionAuthorityRoot ===
    expectedAbstractionAuthorityRoot;
  checks.push(
    check(
      'exact-work-abstraction-authority-root',
      abstractionMatches ? 'passed' : 'failed',
      expectedAbstractionAuthorityRoot,
    ),
  );
  if (!abstractionMatches)
    diagnostics.push(
      diagnostic(
        'work-abstraction-authority-root-mismatch',
        INVALID,
        'The declaration is not bound to the current generic Work lifecycle authority.',
      ),
    );

  const roleRoots = Object.values(declaration.bindings.roleSchemaRoots);
  const rolesSeparated = new Set(roleRoots).size === roleRoots.length;
  checks.push(
    check(
      'responsibility-role-root-separation',
      rolesSeparated ? 'passed' : 'failed',
    ),
  );
  if (!rolesSeparated)
    diagnostics.push(
      diagnostic(
        'responsibility-role-roots-fused',
        INVALID,
        'The five responsibility roles must retain distinct schema roots.',
      ),
    );

  const reuse = declaration.reuse;
  const genericReuse = [
    reuse.factEpisode,
    reuse.actionGeometry,
    reuse.workLifecycle,
    reuse.cut,
  ].every((value) => value === 'generic');
  checks.push(
    check('generic-authority-reuse', genericReuse ? 'passed' : 'failed'),
  );
  if (!genericReuse)
    diagnostics.push(
      diagnostic(
        'generic-authority-substituted',
        INCOMPATIBLE,
        'The scenario substitutes at least one generic Fact/Episode, Action Geometry, Work lifecycle, or Cut authority.',
      ),
    );
  if (reuse.domainSpecificCoreFork)
    diagnostics.push(
      diagnostic(
        'domain-core-fork-required',
        INCOMPATIBLE,
        'The scenario declares a domain-specific Core fork.',
      ),
    );
  if (reuse.parallelAuthority)
    diagnostics.push(
      diagnostic(
        'parallel-authority-required',
        INCOMPATIBLE,
        'The scenario declares a parallel service, database, registry, or semantic authority.',
      ),
    );

  for (const [name, judgment] of Object.entries(declaration.humanAuthority)) {
    const complete =
      judgment.status === 'human-declared' &&
      typeof judgment.statement === 'string' &&
      judgment.statement.length > 0 &&
      typeof judgment.authorityRoot === 'string';
    checks.push(
      check(
        `human-authority-${name}`,
        complete ? 'declared' : 'missing',
        judgment.authorityRoot,
      ),
    );
    if (!complete)
      diagnostics.push(
        diagnostic(
          `human-authority-${name}-missing`,
          UNQUALIFIED,
          `${name} must remain an explicit human judgment; the gate cannot infer it.`,
        ),
      );
  }

  const evidenceByCase = new Map();
  for (const evidence of declaration.behaviorEvidence) {
    if (evidenceByCase.has(evidence.case)) {
      diagnostics.push(
        diagnostic(
          `behavior-${evidence.case}-duplicate`,
          INVALID,
          `Behavior evidence for ${evidence.case} is duplicated.`,
        ),
      );
      continue;
    }
    evidenceByCase.set(evidence.case, evidence);
  }
  for (const caseId of BEHAVIOR_CASES) {
    const evidence = evidenceByCase.get(caseId);
    checks.push(
      check(
        `behavior-${caseId}`,
        evidence?.status || 'missing',
        evidence?.evidenceRoot,
      ),
    );
    if (
      !evidence ||
      ['missing', 'stale', 'crashed', 'unsupported'].includes(evidence.status)
    )
      diagnostics.push(
        diagnostic(
          `behavior-${caseId}-${evidence?.status || 'missing'}`,
          UNQUALIFIED,
          `Retained ${caseId} evidence is not qualified.`,
        ),
      );
    else if (evidence.status === 'failed')
      diagnostics.push(
        diagnostic(
          `behavior-${caseId}-failed`,
          INCOMPATIBLE,
          `The scenario failed the ${caseId} generic-semantics witness.`,
        ),
      );
    else if (!evidence.evidenceRoot)
      diagnostics.push(
        diagnostic(
          `behavior-${caseId}-root-missing`,
          INVALID,
          `Passed ${caseId} evidence must retain an exact root.`,
        ),
      );
    else {
      const retained = retainEvidence(
        diagnostics,
        `behavior-${caseId}`,
        evidence,
      );
      if (
        retained.status === 'verified' &&
        retained.value &&
        (retained.value.case !== caseId ||
          retained.value.status !== evidence.status)
      )
        diagnostics.push(
          diagnostic(
            `behavior-${caseId}-evidence-semantic-mismatch`,
            INVALID,
            `Retained evidence does not describe the declared ${caseId} result.`,
          ),
        );
    }
  }

  const platformNames = new Set();
  for (const adapter of declaration.platformAdapters) {
    if (platformNames.has(adapter.platform))
      diagnostics.push(
        diagnostic(
          `platform-${adapter.platform}-duplicate`,
          INVALID,
          `Platform adapter ${adapter.platform} is duplicated.`,
        ),
      );
    platformNames.add(adapter.platform);
    if (adapter.relevance === 'not-relevant') continue;
    checks.push(
      check(
        `platform-${adapter.platform}`,
        adapter.status,
        adapter.evidenceRoot,
      ),
    );
    if (adapter.status === 'failed')
      diagnostics.push(
        diagnostic(
          `platform-${adapter.platform}-failed`,
          INCOMPATIBLE,
          `${adapter.platform} contradicts the declared generic semantics.`,
        ),
      );
    else if (adapter.status !== 'passed' || !adapter.evidenceRoot)
      diagnostics.push(
        diagnostic(
          `platform-${adapter.platform}-unqualified`,
          UNQUALIFIED,
          `${adapter.platform} is relevant but lacks passing rooted parity evidence.`,
        ),
      );
    else retainEvidence(diagnostics, `platform-${adapter.platform}`, adapter);
  }

  const surfaceNames = new Set();
  for (const surface of declaration.profileSurfaces) {
    if (surfaceNames.has(surface.surface))
      diagnostics.push(
        diagnostic(
          `surface-${surface.surface}-duplicate`,
          INVALID,
          `Profile surface ${surface.surface} is duplicated.`,
        ),
      );
    surfaceNames.add(surface.surface);
    if (surface.relevance === 'required' && surface.status !== 'supported')
      diagnostics.push(
        diagnostic(
          `surface-${surface.surface}-unsupported`,
          UNQUALIFIED,
          `Required Profile surface ${surface.surface} is explicitly unsupported.`,
        ),
      );
  }

  const buildchain = declaration.buildchain;
  checks.push(
    check('buildchain-admission', buildchain.status, buildchain.evidenceRoot),
  );
  const retainedBuildchain = retainEvidence(
    diagnostics,
    'buildchain-admission',
    buildchain,
  );
  if (
    retainedBuildchain.status === 'verified' &&
    retainedBuildchain.value &&
    (retainedBuildchain.value.status !== buildchain.status ||
      retainedBuildchain.value.sourceRoot !== buildchain.sourceRoot ||
      retainedBuildchain.value.fresh !== buildchain.fresh ||
      retainedBuildchain.value.compatible !== buildchain.compatible ||
      retainedBuildchain.value.manualAllowlist !== buildchain.manualAllowlist)
  )
    diagnostics.push(
      diagnostic(
        'buildchain-evidence-semantic-mismatch',
        INVALID,
        'Retained Buildchain evidence does not match the declared admission fields.',
      ),
    );
  if (buildchain.manualAllowlist)
    diagnostics.push(
      diagnostic(
        'buildchain-manual-allowlist-forbidden',
        INVALID,
        'Manual allowlists cannot substitute for retained Buildchain evidence.',
      ),
    );
  if (
    buildchain.status === 'mismatch' ||
    buildchain.sourceRoot !== declaration.bindings.sourceRoot
  )
    diagnostics.push(
      diagnostic(
        'buildchain-source-root-mismatch',
        INVALID,
        'Buildchain evidence is not bound to the declared source root.',
      ),
    );
  else if (buildchain.status === 'incompatible' || !buildchain.compatible)
    diagnostics.push(
      diagnostic(
        'buildchain-incompatible',
        INCOMPATIBLE,
        'The retained Buildchain evidence is incompatible with this Profile declaration.',
      ),
    );
  else if (
    buildchain.status !== 'admitted' ||
    !buildchain.fresh ||
    !buildchain.evidenceRoot
  )
    diagnostics.push(
      diagnostic(
        `buildchain-${buildchain.status === 'admitted' ? 'stale' : buildchain.status}`,
        UNQUALIFIED,
        'Buildchain admission evidence is absent, stale, or incomplete.',
      ),
    );

  const operations = declaration.workOperationModel;
  const requiredOperations = [
    'inspect',
    'validate',
    'qualify',
    'plan',
    'execute',
    'settle',
    'recover',
    'archive',
  ];
  const operationModelValid =
    operations.authority === 'existing-work-lifecycle' &&
    operations.separateAssignment === false &&
    requiredOperations.every((operation) =>
      operations.operations.includes(operation),
    );
  checks.push(
    check(
      'generic-work-operation-model',
      operationModelValid ? 'passed' : 'failed',
    ),
  );
  if (!operationModelValid)
    diagnostics.push(
      diagnostic(
        'separate-work-authority-required',
        INCOMPATIBLE,
        'The high-level operation model must reuse Work lifecycle and cannot close through a separate Assignment.',
      ),
    );

  for (const constraint of declaration.constraints)
    diagnostics.push(
      diagnostic(
        `declared-constraint-${contentRoot(constraint).slice(7, 19)}`,
        CONSTRAINT,
        constraint,
      ),
    );

  diagnostics.sort((a, b) => a.code.localeCompare(b.code));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  const verdict = verdictFor(diagnostics, declaration.constraints);
  const stable = {
    schema: 'kungfu.work-profile-conformance-result/v1',
    scenarioId: declaration.scenarioId,
    verdict,
    declarationRoot,
    authorityBindings: declaration.bindings,
    machineChecks: checks,
    humanAuthority: declaration.humanAuthority,
    diagnostics,
    constraints: declaration.constraints,
    residualRisk: declaration.residualRisk,
    lifecycleMutation: false,
  };
  const conformanceRoot = contentRoot(stable);
  const surfaceRoots = Object.fromEntries(
    declaration.profileSurfaces
      .filter(
        (surface) =>
          surface.relevance === 'required' && surface.status === 'supported',
      )
      .map((surface) => [surface.surface, conformanceRoot])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return { ...stable, conformanceRoot, surfaceRoots };
}

export function validateResult(result) {
  const validate = schemaValidator(RESULT_SCHEMA_PATH);
  return { ok: Boolean(validate(result)), errors: validate.errors || [] };
}

export function checkReferenceQualification() {
  const suite = readJson(QUALIFICATION_PATH);
  const results = suite.scenarios.map((scenario) => {
    const result = evaluateConformance(scenario.declaration);
    const resultValidation = validateResult(result);
    if (!resultValidation.ok)
      throw new Error(
        `result-schema-invalid: ${JSON.stringify(resultValidation.errors)}`,
      );
    if (result.verdict !== scenario.expectedVerdict)
      throw new Error(
        `reference-verdict-mismatch: ${scenario.declaration.scenarioId} expected ${scenario.expectedVerdict}, got ${result.verdict}`,
      );
    const roots = new Set(Object.values(result.surfaceRoots));
    if (roots.size > 1)
      throw new Error(
        `surface-root-mismatch: ${scenario.declaration.scenarioId}`,
      );
    return {
      scenarioId: result.scenarioId,
      verdict: result.verdict,
      declarationRoot: result.declarationRoot,
      conformanceRoot: result.conformanceRoot,
    };
  });
  return {
    schema: 'kungfu.work-profile-conformance-qualification/v1',
    status: 'passed',
    actionGeometryRoot: fileRoot(ACTION_GEOMETRY_PATH),
    workAbstractionAuthorityRoot: fileRoot(WORK_LIFECYCLE_PATH),
    scenarios: results,
    qualificationRoot: contentRoot(results),
    lifecycleMutation: false,
  };
}

function parseArgs(argv) {
  const options = {
    json: false,
    check: false,
    help: false,
    declaration: null,
    surface: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--declaration') options.declaration = argv[++index];
    else if (arg === '--surface') options.surface = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        'Kungfu Work Profile Conformance Gate',
        '',
        'Usage:',
        '  ./shifu work-profile:conformance -- --declaration FILE [--surface validate|qualify|authoring-check|installed-runtime] [--json]',
        '  ./shifu check:work-profile-conformance',
        '',
        'The gate is read-only. It never installs a Profile, mutates lifecycle state, creates or closes an Assignment, or infers domain identity, authorization, success, privacy, evidence strength, or consequence meaning.',
        '',
      ].join('\n'),
    );
    return;
  }
  let output;
  if (options.check) output = checkReferenceQualification();
  else {
    if (!options.declaration) throw new Error('--declaration is required');
    const declaration = readJson(path.resolve(options.declaration));
    output = evaluateConformance(declaration);
    if (options.surface) {
      const declared = declaration.profileSurfaces?.find(
        (surface) => surface.surface === options.surface,
      );
      if (!declared || declared.status !== 'supported')
        throw new Error(`profile-surface-unsupported: ${options.surface}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify(output, null, options.json ? 2 : 0)}\n`,
  );
  if (
    'verdict' in output &&
    !['compatible', 'compatible-with-constraints'].includes(output.verdict)
  )
    process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[work-profile-conformance] ${error.message}\n`);
    process.exitCode = 3;
  }
}
