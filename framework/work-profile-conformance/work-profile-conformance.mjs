#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(MODULE_DIR, '../..');
const BUNDLED_ROOT = path.join(MODULE_DIR, 'authority');
const ROOT = fs.existsSync(
  path.join(SOURCE_ROOT, 'framework/action/action-geometry.contract.json'),
)
  ? SOURCE_ROOT
  : BUNDLED_ROOT;
const DECLARATION_SCHEMA_PATH = path.join(
  MODULE_DIR,
  'schema/work-profile-conformance-declaration-v1.schema.json',
);
const RESULT_SCHEMA_PATH = path.join(
  MODULE_DIR,
  'schema/work-profile-conformance-result-v1.schema.json',
);
const RETAINED_EVIDENCE_PATH = path.join(
  ROOT,
  'framework/work-profile-conformance/qualification/retained-witnesses.json',
);
const ACTION_GEOMETRY_PATH = path.join(
  ROOT,
  'framework/action/action-geometry.contract.json',
);
const WORK_LIFECYCLE_PATH = path.join(
  ROOT,
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
);
const WORK_API_PATH = path.join(
  ROOT,
  'framework/work-loop/work-api.contract.json',
);

const RESPONSIBILITY_ROLES = ['fact', 'episode', 'pursuit', 'atlas', 'warrant'];
const PLATFORMS = ['cpp', 'python', 'node', 'rust'];
const PROFILE_SURFACES = [
  'validate',
  'qualify',
  'authoring-check',
  'installed-runtime',
];
const NON_CLAIMS = [
  'The verdict does not invent domain identity, legitimate authorization, success, privacy, evidence strength, or consequence meaning.',
  'The verdict does not install or activate a Profile, mutate lifecycle state, create or close an Assignment, or settle Work.',
  'A compatible adapter or public projection does not become semantic authority.',
];

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

const KFD_BEHAVIOR = {
  'provider-switch': {
    category: 'backend-migration',
    checks: [
      'storage-backend-switch-delegation-declared',
      'five-role-identity-conservation-witness',
      'file-rocksdb-file-rollback',
    ],
  },
  'projection-rebuild': {
    category: 'export-import-rebuild',
    checks: [
      'projection-rebuild-from-native-journal',
      'qualified-fact-export-import-bundle',
      'tampered-bundle-fails-before-write',
    ],
  },
  recovery: {
    category: 'cold-start-continuation',
    checks: [
      'fresh-home-bootstrap-action',
      'clean-home-continuation-from-qualified-export',
      'clean-home-next-revision',
    ],
  },
};

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
      value: absolute.endsWith('.json')
        ? JSON.parse(fs.readFileSync(absolute, 'utf8'))
        : null,
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
      coordinate,
    ),
  );
  return retained;
}

function diagnostic(code, classification, message, evidenceCoordinate = null) {
  return {
    code,
    class: classification,
    message,
    violatedInvariant: code,
    evidenceCoordinate: evidenceCoordinate
      ? {
          evidenceRoot: evidenceCoordinate.evidenceRoot,
          evidencePath: evidenceCoordinate.evidencePath ?? null,
          evidencePointer: evidenceCoordinate.evidencePointer ?? null,
        }
      : null,
  };
}

function check(id, status, evidenceRoot = null) {
  return { id, status, evidenceRoot };
}

function schemaTypeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'null') return value === null;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function subsetSchemaErrors(value, schema, rootSchema, instancePath = '') {
  if (schema.$ref) {
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce((current, key) => current[key], rootSchema);
    return subsetSchemaErrors(value, target, rootSchema, instancePath);
  }
  if (schema.anyOf) {
    if (
      schema.anyOf.some(
        (candidate) =>
          subsetSchemaErrors(value, candidate, rootSchema, instancePath)
            .length === 0,
      )
    )
      return [];
    return [
      {
        instancePath,
        keyword: 'anyOf',
        message: 'must match one allowed shape',
      },
    ];
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => schemaTypeMatches(value, type)))
    return [
      {
        instancePath,
        keyword: 'type',
        message: `must be ${types.join(' or ')}`,
      },
    ];
  if ('const' in schema && value !== schema.const)
    return [
      {
        instancePath,
        keyword: 'const',
        message: `must equal ${JSON.stringify(schema.const)}`,
      },
    ];
  if (schema.enum && !schema.enum.includes(value))
    return [
      {
        instancePath,
        keyword: 'enum',
        message: 'must be an allowed value',
      },
    ];
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength)
      return [
        {
          instancePath,
          keyword: 'minLength',
          message: `must have at least ${schema.minLength} characters`,
        },
      ];
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      return [
        {
          instancePath,
          keyword: 'pattern',
          message: `must match ${schema.pattern}`,
        },
      ];
  }
  const errors = [];
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems)
      errors.push({
        instancePath,
        keyword: 'minItems',
        message: `must contain at least ${schema.minItems} items`,
      });
    if (schema.uniqueItems) {
      const roots = value.map(contentRoot);
      if (new Set(roots).size !== roots.length)
        errors.push({
          instancePath,
          keyword: 'uniqueItems',
          message: 'must not contain duplicates',
        });
    }
    if (schema.items)
      value.forEach((item, index) =>
        errors.push(
          ...subsetSchemaErrors(
            item,
            schema.items,
            rootSchema,
            `${instancePath}/${index}`,
          ),
        ),
      );
  } else if (value && typeof value === 'object') {
    for (const required of schema.required || [])
      if (!(required in value))
        errors.push({
          instancePath,
          keyword: 'required',
          message: `must contain ${required}`,
        });
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!(key in (schema.properties || {})))
          errors.push({
            instancePath: `${instancePath}/${key}`,
            keyword: 'additionalProperties',
            message: 'is not allowed',
          });
    for (const [key, propertySchema] of Object.entries(schema.properties || {}))
      if (key in value)
        errors.push(
          ...subsetSchemaErrors(
            value[key],
            propertySchema,
            rootSchema,
            `${instancePath}/${key}`,
          ),
        );
  }
  return errors;
}

function schemaValidator(schemaPath) {
  const schema = readJson(schemaPath);
  const validate = (value) => {
    validate.errors = subsetSchemaErrors(value, schema, schema);
    return validate.errors.length === 0;
  };
  validate.errors = null;
  return validate;
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
  for (const item of diagnostics)
    if (!item.evidenceCoordinate)
      item.evidenceCoordinate = {
        evidenceRoot: declarationRoot,
        evidencePath: null,
        evidencePointer: null,
      };
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
    nonClaims: NON_CLAIMS,
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

function conformanceContext(declaration) {
  return {
    declaration,
    diagnostics: [],
    checks: [],
    declarationRoot: contentRoot(declaration),
  };
}

function validateAuthorityBindings(context) {
  const { declaration, diagnostics, checks } = context;
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

  const bindingCoordinates = {
    actionGeometryRoot: declaration.bindings.actionGeometryPath,
    domainProfileRoot: declaration.bindings.domainProfilePath,
    abstractionAuthorityRoot: declaration.bindings.abstractionAuthorityPath,
    sourceRoot: declaration.bindings.sourcePath,
  };
  for (const [rootField, evidencePath] of Object.entries(bindingCoordinates)) {
    const retained = retainEvidence(diagnostics, `binding-${rootField}`, {
      evidencePath,
      evidencePointer: null,
      evidenceRoot: declaration.bindings[rootField],
    });
    checks.push(
      check(
        `binding-${rootField}`,
        retained.status === 'verified' ? 'passed' : 'failed',
        declaration.bindings[rootField],
      ),
    );
  }

  for (const role of RESPONSIBILITY_ROLES) {
    const retained = retainEvidence(diagnostics, `binding-role-${role}`, {
      evidencePath: declaration.bindings.roleSchemaPaths[role],
      evidencePointer: null,
      evidenceRoot: declaration.bindings.roleSchemaRoots[role],
    });
    checks.push(
      check(
        `binding-role-${role}`,
        retained.status === 'verified' ? 'passed' : 'failed',
        declaration.bindings.roleSchemaRoots[role],
      ),
    );
  }

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
}

function validateGenericReuse(context) {
  const { declaration, diagnostics, checks } = context;
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
}

function validateHumanAuthority(context) {
  const { declaration, diagnostics, checks } = context;
  for (const [name, judgment] of Object.entries(declaration.humanAuthority)) {
    const expectedAuthorityRoot = contentRoot({
      scenarioId: declaration.scenarioId,
      domainProfileRoot: declaration.bindings.domainProfileRoot,
      field: name,
      status: judgment.status,
      statement: judgment.statement,
    });
    const complete =
      judgment.status === 'human-declared' &&
      typeof judgment.statement === 'string' &&
      judgment.statement.length > 0 &&
      judgment.authorityRoot === expectedAuthorityRoot;
    checks.push(
      check(
        `human-authority-${name}`,
        complete ? 'declared' : 'missing',
        complete ? expectedAuthorityRoot : judgment.authorityRoot,
      ),
    );
    if (!complete)
      diagnostics.push(
        diagnostic(
          `human-authority-${name}-missing`,
          UNQUALIFIED,
          `${name} must remain an explicit, content-bound human judgment; the gate cannot infer or re-root it.`,
        ),
      );
  }
}

function indexBehaviorEvidence(context) {
  const { declaration, diagnostics, checks } = context;
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
  return evidenceByCase;
}

function retainBehaviorCase(context, caseId, evidence) {
  const { diagnostics, checks } = context;
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
  ) {
    diagnostics.push(
      diagnostic(
        `behavior-${caseId}-${evidence?.status || 'missing'}`,
        UNQUALIFIED,
        `Retained ${caseId} evidence is not qualified.`,
      ),
    );
    return null;
  }
  if (evidence.status === 'failed') {
    diagnostics.push(
      diagnostic(
        `behavior-${caseId}-failed`,
        INCOMPATIBLE,
        `The scenario failed the ${caseId} generic-semantics witness.`,
      ),
    );
    return null;
  }
  if (!evidence.evidenceRoot) {
    diagnostics.push(
      diagnostic(
        `behavior-${caseId}-root-missing`,
        INVALID,
        `Passed ${caseId} evidence must retain an exact root.`,
      ),
    );
    return null;
  }
  const retained = retainEvidence(diagnostics, `behavior-${caseId}`, evidence);
  return retained.status === 'verified' ? retained.value : null;
}

function matchesKfdBehavior(context, caseId, evidence, value, kfd) {
  const { declaration, diagnostics } = context;
  const passedChecks = new Set(
    (value.checks || [])
      .filter(({ status }) => status === 'pass')
      .map(({ id }) => id),
  );
  const revisionMatch =
    value.sourceSha === declaration.buildchain.sourceRevision;
  if (!revisionMatch)
    diagnostics.push(
      diagnostic(
        `behavior-${caseId}-buildchain-revision-mismatch`,
        INVALID,
        `Retained ${caseId} evidence was produced at ${value.sourceSha || '<missing>'}, not the admitted Buildchain source ${declaration.buildchain.sourceRevision}.`,
        evidence,
      ),
    );
  return (
    value.contract === 'kungfu-buildchain-kfd-7-evidence-report' &&
    value.category === kfd.category &&
    value.outcome === 'pass' &&
    value.matchedExpectation === true &&
    revisionMatch &&
    kfd.checks.every((id) => passedChecks.has(id))
  );
}

function matchesRuntimeBehavior(context, caseId, value) {
  const { diagnostics } = context;
  let semanticMatch =
    value.schema === 'kungfu.work-profile-runtime-behavior-witness/v1' &&
    value.case === caseId &&
    value.status === 'passed' &&
    canonicalJson(value.actual) ===
      canonicalJson({ ...value.actual, ...value.expected });
  for (const coordinate of value.implementation || [])
    if (
      retainEvidence(
        diagnostics,
        `behavior-${caseId}-implementation`,
        coordinate,
      ).status !== 'verified'
    )
      semanticMatch = false;
  return semanticMatch;
}

function validateBehaviorCase(context, caseId, evidence) {
  const value = retainBehaviorCase(context, caseId, evidence);
  if (!value) return;
  const kfd = KFD_BEHAVIOR[caseId];
  const semanticMatch = kfd
    ? matchesKfdBehavior(context, caseId, evidence, value, kfd)
    : matchesRuntimeBehavior(context, caseId, value);
  if (!semanticMatch)
    context.diagnostics.push(
      diagnostic(
        `behavior-${caseId}-evidence-semantic-mismatch`,
        INVALID,
        `Retained evidence does not prove the required ${caseId} behavior through the existing runtime authority.`,
        evidence,
      ),
    );
}

function validateBehaviorEvidence(context) {
  const evidenceByCase = indexBehaviorEvidence(context);
  for (const caseId of BEHAVIOR_CASES) {
    validateBehaviorCase(context, caseId, evidenceByCase.get(caseId));
  }
}

function validatePlatformAdapters(context) {
  const { declaration, diagnostics, checks } = context;
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
    if (adapter.relevance === 'not-relevant')
      diagnostics.push(
        diagnostic(
          `platform-${adapter.platform}-not-relevant-forbidden`,
          INVALID,
          `Closed-world conformance requires explicit evidence for ${adapter.platform}.`,
        ),
      );
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
  for (const platform of PLATFORMS)
    if (!platformNames.has(platform))
      diagnostics.push(
        diagnostic(
          `platform-${platform}-omitted`,
          INVALID,
          `Platform ${platform} must be declared as required or explicitly not relevant.`,
        ),
      );
}

function validateProfileSurfaces(context) {
  const { declaration, diagnostics } = context;
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
    if (surface.relevance === 'not-relevant')
      diagnostics.push(
        diagnostic(
          `surface-${surface.surface}-not-relevant-forbidden`,
          INVALID,
          `Closed-world conformance requires ${surface.surface} support.`,
        ),
      );
    if (surface.relevance === 'required' && surface.status !== 'supported')
      diagnostics.push(
        diagnostic(
          `surface-${surface.surface}-unsupported`,
          UNQUALIFIED,
          `Required Profile surface ${surface.surface} is explicitly unsupported.`,
        ),
      );
  }
  for (const surface of PROFILE_SURFACES)
    if (!surfaceNames.has(surface))
      diagnostics.push(
        diagnostic(
          `surface-${surface}-omitted`,
          INVALID,
          `Profile surface ${surface} must be declared as required or explicitly not relevant.`,
        ),
      );
}

function validateRetainedBuildchain(context, buildchain) {
  const { declaration, diagnostics, checks } = context;
  checks.push(
    check('buildchain-admission', buildchain.status, buildchain.evidenceRoot),
  );
  const retained = retainEvidence(
    diagnostics,
    'buildchain-admission',
    buildchain,
  );
  if (
    retained.status === 'verified' &&
    retained.value &&
    (retained.value.contract !== 'kungfu-buildchain-kfd-product-gate' ||
      retained.value.standard !== 'kfd-7' ||
      retained.value.status !== buildchain.status ||
      retained.value.source?.sha !== buildchain.sourceRevision ||
      retained.value.gateRoot !== buildchain.gateRoot ||
      retained.value.selfCertified !== buildchain.selfCertified)
  )
    diagnostics.push(
      diagnostic(
        'buildchain-evidence-semantic-mismatch',
        INVALID,
        'Retained Buildchain evidence does not match the declared admission fields.',
      ),
    );
  if (retained.status === 'verified' && retained.value) {
    const admittedEvidence = new Map(
      (retained.value.evidence || []).map((coordinate) => [
        coordinate.id,
        coordinate.sha256,
      ]),
    );
    const missingKfdEvidence = declaration.behaviorEvidence.filter(
      (evidence) =>
        KFD_BEHAVIOR[evidence.case] &&
        admittedEvidence.get(KFD_BEHAVIOR[evidence.case].category) !==
          evidence.evidenceRoot,
    );
    if (missingKfdEvidence.length > 0)
      diagnostics.push(
        diagnostic(
          'buildchain-runtime-evidence-not-admitted',
          INVALID,
          'The retained Buildchain gate does not admit every reused KFD-7 runtime report at its exact root.',
          missingKfdEvidence[0],
        ),
      );
  }
}

function validateBuildchainAuthority(context, buildchain) {
  const { diagnostics } = context;
  const buildchainAuthority = retainEvidence(
    diagnostics,
    'buildchain-authority',
    {
      evidencePath: buildchain.authorityPath,
      evidencePointer: null,
      evidenceRoot: buildchain.authorityRoot,
    },
  );
  if (
    buildchainAuthority.status !== 'verified' ||
    buildchain.provider !== 'kungfu-buildchain' ||
    buildchain.runner !== 'kfd-product-gate' ||
    !/^[0-9a-f]{40}$/u.test(buildchain.sourceRevision) ||
    buildchain.selfCertified !== false
  )
    diagnostics.push(
      diagnostic(
        'buildchain-evidence-incomplete',
        UNQUALIFIED,
        'Buildchain admission requires an exact non-self-certified product gate, authority input, provider, runner, and source revision.',
      ),
    );
}

function validateBuildchainStatus(context, buildchain) {
  const { diagnostics } = context;
  if (buildchain.manualAllowlist)
    diagnostics.push(
      diagnostic(
        'buildchain-manual-allowlist-forbidden',
        INVALID,
        'Manual allowlists cannot substitute for retained Buildchain evidence.',
      ),
    );
  if (buildchain.status === 'mismatch')
    diagnostics.push(
      diagnostic(
        'buildchain-source-root-mismatch',
        INVALID,
        'Buildchain product-gate root does not match the retained gate.',
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
  else if (buildchain.status !== 'passed' || !buildchain.evidenceRoot)
    diagnostics.push(
      diagnostic(
        `buildchain-${buildchain.status}`,
        UNQUALIFIED,
        'Buildchain product-gate evidence is absent, stale, or incomplete.',
      ),
    );
}

function validateBuildchainEvidence(context) {
  const buildchain = context.declaration.buildchain;
  validateRetainedBuildchain(context, buildchain);
  validateBuildchainAuthority(context, buildchain);
  validateBuildchainStatus(context, buildchain);
}

function validateWorkOperationModel(context) {
  const { declaration, diagnostics, checks } = context;
  const operations = declaration.workOperationModel;
  const workApi = readJson(WORK_API_PATH);
  const requiredOperations = workApi.actions.map(({ id }) => id).sort();
  const declaredOperations = [...operations.operations].sort();
  const expectedWorkApiRoot = fileRoot(WORK_API_PATH);
  const operationModelValid =
    operations.authority === 'existing-work-api' &&
    operations.authorityRoot === expectedWorkApiRoot &&
    operations.separateAssignment === false &&
    canonicalJson(declaredOperations) === canonicalJson(requiredOperations);
  checks.push(
    check(
      'generic-work-operation-model',
      operationModelValid ? 'passed' : 'failed',
      expectedWorkApiRoot,
    ),
  );
  if (!operationModelValid)
    diagnostics.push(
      diagnostic(
        'separate-work-authority-required',
        INCOMPATIBLE,
        'The high-level operation model must bind the existing Work API contract exactly and cannot close through a separate Assignment.',
      ),
    );
}

function buildConformanceResult(context) {
  const { declaration, diagnostics, checks, declarationRoot } = context;
  for (const constraint of declaration.constraints)
    diagnostics.push(
      diagnostic(
        `declared-constraint-${contentRoot(constraint).slice(7, 19)}`,
        CONSTRAINT,
        constraint,
      ),
    );

  for (const item of diagnostics)
    if (!item.evidenceCoordinate)
      item.evidenceCoordinate = {
        evidenceRoot: declarationRoot,
        evidencePath: null,
        evidencePointer: null,
      };
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
    nonClaims: NON_CLAIMS,
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

export function evaluateConformance(declaration) {
  const validate = schemaValidator(DECLARATION_SCHEMA_PATH);
  if (!validate(declaration))
    return resultForInvalid(declaration, schemaDiagnostics(validate.errors));
  const context = conformanceContext(declaration);
  validateAuthorityBindings(context);
  validateGenericReuse(context);
  validateHumanAuthority(context);
  validateBehaviorEvidence(context);
  validatePlatformAdapters(context);
  validateProfileSurfaces(context);
  validateBuildchainEvidence(context);
  validateWorkOperationModel(context);
  return buildConformanceResult(context);
}

export function validateResult(result) {
  const validate = schemaValidator(RESULT_SCHEMA_PATH);
  return { ok: Boolean(validate(result)), errors: validate.errors || [] };
}

export function checkReferenceQualification() {
  if (ROOT === SOURCE_ROOT) {
    const generated = spawnSync(
      process.execPath,
      [path.join(MODULE_DIR, 'generate-qualification.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (generated.status !== 0)
      throw new Error(
        `generated-qualification-stale: ${`${generated.stdout || ''}${generated.stderr || ''}`.trim()}`,
      );
  }
  const suite = readJson(
    path.join(
      ROOT,
      'framework/work-profile-conformance/qualification/reference-scenarios.json',
    ),
  );
  const retained = readJson(RETAINED_EVIDENCE_PATH);
  const retainedRoot = contentRoot(retained);
  const results = suite.scenarios.map((scenario) => {
    const result = evaluateConformance(scenario.declaration);
    const resultValidation = validateResult(result);
    if (!resultValidation.ok)
      throw new Error(
        `result-schema-invalid: ${JSON.stringify(resultValidation.errors)}`,
      );
    if (!['compatible', 'compatible-with-constraints'].includes(result.verdict))
      throw new Error(
        `reference-verdict-failed: ${scenario.declaration.scenarioId} got ${result.verdict}`,
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
  const agent = suite.scenarios[0].declaration;
  const calendar = suite.scenarios[1].declaration;
  const adversarial = [
    [
      'forged-domain-root',
      (value) => {
        value.bindings.domainProfileRoot = `sha256:${'9'.repeat(64)}`;
      },
    ],
    [
      'omitted-platform',
      (value) => {
        value.platformAdapters = value.platformAdapters.filter(
          ({ platform }) => platform !== 'rust',
        );
      },
    ],
    [
      'omitted-surface',
      (value) => {
        value.profileSurfaces = value.profileSurfaces.filter(
          ({ surface }) => surface !== 'qualify',
        );
      },
    ],
    [
      'manual-buildchain-allowlist',
      (value) => {
        value.buildchain.manualAllowlist = true;
      },
    ],
    [
      'separate-assignment',
      (value) => {
        value.workOperationModel.separateAssignment = true;
      },
    ],
  ].map(([id, mutate]) => {
    const declaration = structuredClone(agent);
    mutate(declaration);
    const result = evaluateConformance(declaration);
    if (['compatible', 'compatible-with-constraints'].includes(result.verdict))
      throw new Error(`negative-qualification-false-positive: ${id}`);
    return {
      id,
      verdict: result.verdict,
      conformanceRoot: result.conformanceRoot,
    };
  });
  return {
    schema: 'kungfu.work-profile-conformance-qualification/v1',
    status: 'passed',
    actionGeometryRoot: fileRoot(ACTION_GEOMETRY_PATH),
    workAbstractionAuthorityRoot: fileRoot(WORK_LIFECYCLE_PATH),
    generatedEvidenceRoot: retainedRoot,
    scenarios: results,
    negativeCaseCount: adversarial.length,
    qualificationRoot: contentRoot({ results, adversarial }),
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
      if (
        !declared ||
        declared.relevance !== 'required' ||
        declared.status !== 'supported' ||
        !output.surfaceRoots?.[options.surface]
      )
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
