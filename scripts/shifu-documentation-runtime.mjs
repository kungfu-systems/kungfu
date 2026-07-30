// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENTATION_SUBMISSION_SCHEMA =
  'https://libkungfu.dev/schemas/shifu/documentation-project-v1.schema.json';
export const DOCUMENTATION_RECEIPT_SCHEMA =
  'https://libkungfu.dev/schemas/shifu/documentation-validation-receipt-v1.schema.json';

const TOP_KEYS = [
  '$schema',
  'schema',
  'project',
  'roots',
  'documentProfiles',
  'verificationProfiles',
  'providers',
  'routes',
  'policies',
];
const OPTIONAL_TOP_KEYS = ['surfacePolicy'];
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VISIBILITY = ['public', 'internal', 'private'];
const VISIBILITY_RANK = new Map(
  VISIBILITY.map((value, index) => [value, index]),
);
const DOCUMENT_ROLES = [
  'entry',
  'guide',
  'reference',
  'architecture',
  'decision',
  'qualification',
  'generated',
  'compatibility',
];
const METADATA_MODES = ['inline', 'registry', 'external', 'none'];
const VERIFICATION_MODES = ['machine', 'human', 'mixed', 'non-claim'];
const PROVIDER_KINDS = ['subject', 'claim', 'probe', 'artifact'];
const AUTHORITIES = [
  'project',
  'shifu',
  'product-runtime',
  'buildchain',
  'human-review',
];
const SOURCE_FORMATS = [
  'markdown',
  'json',
  'json-schema',
  'shifu-gate-registry',
  'buildchain-passport',
  'generated-index',
];

/** @typedef {{code:string,path:string,message:string}} Diagnostic */
/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{root?:string,checkFiles?:boolean}} ValidationOptions */
/** @typedef {{digest:string,submission:JsonObject|null,valid:boolean,diagnostics:Diagnostic[],projection:JsonObject|null}} DocumentationValidationResult */

/** @param {unknown} value @returns {value is JsonObject} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} left @param {string} right */
function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1)
    if (leftPoints[index] !== rightPoints[index])
      return leftPoints[index] - rightPoints[index];
  return leftPoints.length - rightPoints.length;
}

/** @param {any} value @returns {any} */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

/** @param {any} value */
export function stableJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

/** @param {any} value */
export function documentationDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

/** @param {Diagnostic[]} diagnostics @param {string} code @param {string} at @param {string} message */
function diagnostic(diagnostics, code, at, message) {
  diagnostics.push({ code, path: at || '/', message });
}

/** @param {Diagnostic[]} diagnostics @param {unknown} value @param {string} at @param {string[]} required @param {string[]} [optional] @returns {value is JsonObject} */
function exactKeys(diagnostics, value, at, required, optional = []) {
  if (!object(value)) {
    diagnostic(diagnostics, 'type', at, 'must be an object');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      diagnostic(
        diagnostics,
        'unknown-field',
        `${at}/${key}`,
        'is not declared by v1',
      );
  for (const key of required)
    if (!(key in value))
      diagnostic(diagnostics, 'required-field', `${at}/${key}`, 'is required');
  return true;
}

/** @param {Diagnostic[]} diagnostics @param {unknown} value @param {string} at @param {{id?:boolean}} [options] @returns {value is string} */
function stringField(diagnostics, value, at, { id = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    diagnostic(diagnostics, 'type', at, 'must be a non-empty string');
    return false;
  }
  if (id && !ID.test(value)) {
    diagnostic(diagnostics, 'id', at, 'must be a lowercase dotted identifier');
    return false;
  }
  return true;
}

/** @param {Diagnostic[]} diagnostics @param {unknown} value @param {string} at @param {readonly any[]} allowed */
function enumField(diagnostics, value, at, allowed) {
  if (!allowed.includes(value)) {
    diagnostic(
      diagnostics,
      'enum',
      at,
      `must be one of: ${allowed.join(', ')}`,
    );
    return false;
  }
  return true;
}

/** @param {Diagnostic[]} diagnostics @param {unknown} value @param {string} at @param {{allowRoot?:boolean}} [options] @returns {value is string} */
function repositoryPath(diagnostics, value, at, { allowRoot = false } = {}) {
  if (!stringField(diagnostics, value, at)) return false;
  const normalized = path.posix.normalize(value);
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    /[*?[\]{}]/.test(value) ||
    value !== normalized ||
    (!allowRoot && value === '.')
  ) {
    diagnostic(
      diagnostics,
      'invalid-path',
      at,
      'must be an exact repository-relative POSIX path without traversal or glob syntax',
    );
    return false;
  }
  return true;
}

/** @param {Diagnostic[]} diagnostics @param {JsonObject[]} values @param {string} at */
function uniqueIds(diagnostics, values, at) {
  const ids = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const id = values[index]?.id;
    if (typeof id === 'string' && ids.has(id))
      diagnostic(
        diagnostics,
        'duplicate-id',
        `${at}/${index}/id`,
        `duplicates ${id}`,
      );
    ids.add(id);
  }
}

/** @param {Diagnostic[]} diagnostics @param {unknown} project */
function validateProject(diagnostics, project) {
  if (!exactKeys(diagnostics, project, '/project', ['id', 'title'])) return;
  stringField(diagnostics, project.id, '/project/id', { id: true });
  stringField(diagnostics, project.title, '/project/title');
}

/** @param {Diagnostic[]} diagnostics @param {unknown} roots */
function validateRoots(diagnostics, roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    diagnostic(diagnostics, 'type', '/roots', 'must be a non-empty array');
    return new Map();
  }
  uniqueIds(diagnostics, roots, '/roots');
  const byId = new Map();
  const paths = new Map();
  let content = 0;
  let contract = 0;
  roots.forEach((root, index) => {
    const at = `/roots/${index}`;
    if (!exactKeys(diagnostics, root, at, ['id', 'kind', 'path', 'visibility']))
      return;
    stringField(diagnostics, root.id, `${at}/id`, { id: true });
    enumField(diagnostics, root.kind, `${at}/kind`, ['content', 'contract']);
    repositoryPath(diagnostics, root.path, `${at}/path`, { allowRoot: true });
    enumField(diagnostics, root.visibility, `${at}/visibility`, VISIBILITY);
    if (root.kind === 'content') content += 1;
    if (root.kind === 'contract') contract += 1;
    if (paths.has(root.path))
      diagnostic(
        diagnostics,
        'duplicate-root',
        `${at}/path`,
        `duplicates root path owned by ${paths.get(root.path)}`,
      );
    paths.set(root.path, root.id);
    byId.set(root.id, root);
  });
  if (!content)
    diagnostic(
      diagnostics,
      'root-coverage',
      '/roots',
      'requires at least one content root',
    );
  if (!contract)
    diagnostic(
      diagnostics,
      'root-coverage',
      '/roots',
      'requires at least one contract root',
    );
  return byId;
}

/** @param {Diagnostic[]} diagnostics @param {unknown} profiles */
function validateDocumentProfiles(diagnostics, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    diagnostic(
      diagnostics,
      'type',
      '/documentProfiles',
      'must be a non-empty array',
    );
    return new Map();
  }
  uniqueIds(diagnostics, profiles, '/documentProfiles');
  profiles.forEach((profile, index) => {
    const at = `/documentProfiles/${index}`;
    if (
      !exactKeys(diagnostics, profile, at, [
        'id',
        'role',
        'metadataMode',
        'visibility',
      ])
    )
      return;
    stringField(diagnostics, profile.id, `${at}/id`, { id: true });
    enumField(diagnostics, profile.role, `${at}/role`, DOCUMENT_ROLES);
    enumField(
      diagnostics,
      profile.metadataMode,
      `${at}/metadataMode`,
      METADATA_MODES,
    );
    enumField(diagnostics, profile.visibility, `${at}/visibility`, VISIBILITY);
  });
  return new Map(profiles.map((profile) => [profile.id, profile]));
}

/** @param {Diagnostic[]} diagnostics @param {unknown} profiles */
function validateVerificationProfiles(diagnostics, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    diagnostic(
      diagnostics,
      'type',
      '/verificationProfiles',
      'must be a non-empty array',
    );
    return new Set();
  }
  uniqueIds(diagnostics, profiles, '/verificationProfiles');
  profiles.forEach((profile, index) => {
    const at = `/verificationProfiles/${index}`;
    if (
      !exactKeys(diagnostics, profile, at, [
        'id',
        'mode',
        'gateProfile',
        'reviewRole',
      ])
    )
      return;
    stringField(diagnostics, profile.id, `${at}/id`, { id: true });
    enumField(diagnostics, profile.mode, `${at}/mode`, VERIFICATION_MODES);
    if (profile.gateProfile !== null)
      stringField(diagnostics, profile.gateProfile, `${at}/gateProfile`, {
        id: true,
      });
    if (profile.reviewRole !== null)
      stringField(diagnostics, profile.reviewRole, `${at}/reviewRole`, {
        id: true,
      });
    if (
      ['machine', 'mixed'].includes(profile.mode) &&
      profile.gateProfile === null
    )
      diagnostic(
        diagnostics,
        'verification-obligation',
        `${at}/gateProfile`,
        'is required',
      );
    if (
      ['human', 'mixed'].includes(profile.mode) &&
      profile.reviewRole === null
    )
      diagnostic(
        diagnostics,
        'verification-obligation',
        `${at}/reviewRole`,
        'is required',
      );
    if (
      ['human', 'non-claim'].includes(profile.mode) &&
      profile.gateProfile !== null
    )
      diagnostic(
        diagnostics,
        'verification-obligation',
        `${at}/gateProfile`,
        'must be null',
      );
    if (
      ['machine', 'non-claim'].includes(profile.mode) &&
      profile.reviewRole !== null
    )
      diagnostic(
        diagnostics,
        'verification-obligation',
        `${at}/reviewRole`,
        'must be null',
      );
  });
  return new Set(profiles.map((profile) => profile.id));
}

/** @param {string} file @param {string} root */
function underRoot(file, root) {
  return root === '.' || file === root || file.startsWith(`${root}/`);
}

function validateProviders(
  /** @type {Diagnostic[]} */ diagnostics,
  /** @type {unknown} */
  providers,
  /** @type {Map<string, JsonObject>} */
  roots,
  /** @type {Map<string, JsonObject>} */
  documentProfiles,
  /** @type {Set<string>} */
  verificationProfiles,
  /** @type {ValidationOptions} */
  { root, checkFiles },
) {
  if (!Array.isArray(providers) || providers.length === 0) {
    diagnostic(diagnostics, 'type', '/providers', 'must be a non-empty array');
    return new Map();
  }
  uniqueIds(diagnostics, providers, '/providers');
  const byId = new Map();
  const authorities = new Map();
  providers.forEach((provider, index) => {
    const at = `/providers/${index}`;
    if (
      !exactKeys(diagnostics, provider, at, [
        'id',
        'kind',
        'authority',
        'lifecycle',
        'state',
        'waiver',
        'documentProfile',
        'verificationProfile',
        'visibility',
        'source',
      ])
    )
      return;
    stringField(diagnostics, provider.id, `${at}/id`, { id: true });
    enumField(diagnostics, provider.kind, `${at}/kind`, PROVIDER_KINDS);
    enumField(diagnostics, provider.authority, `${at}/authority`, AUTHORITIES);
    enumField(diagnostics, provider.lifecycle, `${at}/lifecycle`, [
      'active',
      'deprecated',
      'retired',
    ]);
    enumField(diagnostics, provider.state, `${at}/state`, [
      'current',
      'waived',
      'stale',
      'invalidated',
    ]);
    if (provider.state === 'waived') {
      if (
        exactKeys(diagnostics, provider.waiver, `${at}/waiver`, [
          'reason',
          'owner',
          'expires',
        ])
      ) {
        stringField(diagnostics, provider.waiver.reason, `${at}/waiver/reason`);
        stringField(diagnostics, provider.waiver.owner, `${at}/waiver/owner`, {
          id: true,
        });
        stringField(
          diagnostics,
          provider.waiver.expires,
          `${at}/waiver/expires`,
        );
      }
    } else if (provider.waiver !== null)
      diagnostic(
        diagnostics,
        'waiver-state',
        `${at}/waiver`,
        'must be null unless state is waived',
      );
    enumField(diagnostics, provider.visibility, `${at}/visibility`, VISIBILITY);
    const declaredProfile = documentProfiles.get(provider.documentProfile);
    if (!declaredProfile)
      diagnostic(
        diagnostics,
        'unknown-document-profile',
        `${at}/documentProfile`,
        `unknown profile: ${String(provider.documentProfile)}`,
      );
    else if (
      (VISIBILITY_RANK.get(provider.visibility) ?? -1) <
      (VISIBILITY_RANK.get(declaredProfile.visibility) ?? -1)
    )
      diagnostic(
        diagnostics,
        'visibility-broadening',
        `${at}/visibility`,
        `${declaredProfile.visibility} document profile cannot enter ${provider.visibility} provider`,
      );
    if (!verificationProfiles.has(provider.verificationProfile))
      diagnostic(
        diagnostics,
        'unknown-verification-profile',
        `${at}/verificationProfile`,
        `unknown profile: ${String(provider.verificationProfile)}`,
      );
    if (
      exactKeys(diagnostics, provider.source, `${at}/source`, [
        'root',
        'path',
        'format',
      ])
    ) {
      stringField(diagnostics, provider.source.root, `${at}/source/root`, {
        id: true,
      });
      repositoryPath(diagnostics, provider.source.path, `${at}/source/path`);
      enumField(
        diagnostics,
        provider.source.format,
        `${at}/source/format`,
        SOURCE_FORMATS,
      );
      const declaredRoot = roots.get(provider.source.root);
      if (!declaredRoot)
        diagnostic(
          diagnostics,
          'unknown-root',
          `${at}/source/root`,
          `unknown root: ${String(provider.source.root)}`,
        );
      else {
        if (!underRoot(provider.source.path, declaredRoot.path))
          diagnostic(
            diagnostics,
            'root-escape',
            `${at}/source/path`,
            `is outside declared root ${provider.source.root}`,
          );
        if (
          (VISIBILITY_RANK.get(provider.visibility) ?? -1) <
          (VISIBILITY_RANK.get(declaredRoot.visibility) ?? -1)
        )
          diagnostic(
            diagnostics,
            'visibility-broadening',
            `${at}/visibility`,
            `${declaredRoot.visibility} root cannot enter ${provider.visibility} provider`,
          );
      }
      if (
        provider.kind === 'probe' &&
        provider.source.format !== 'shifu-gate-registry'
      )
        diagnostic(
          diagnostics,
          'probe-provider',
          `${at}/source/format`,
          'probe providers must reference a Shifu Gate registry',
        );
      if (checkFiles && root && repositoryPath([], provider.source.path, '')) {
        const resolved = path.join(root, provider.source.path);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
          diagnostic(
            diagnostics,
            'missing-source',
            `${at}/source/path`,
            'does not exist',
          );
      }
      const authorityKey = `${provider.kind}:${provider.source.path}`;
      if (authorities.has(authorityKey))
        diagnostic(
          diagnostics,
          'duplicate-authority',
          `${at}/source/path`,
          `duplicates ${authorities.get(authorityKey)}`,
        );
      authorities.set(authorityKey, provider.id);
    }
    byId.set(provider.id, provider);
  });
  return byId;
}

/** @param {Diagnostic[]} diagnostics @param {unknown} routes @param {Map<string, JsonObject>} providers @param {ValidationOptions} options */
function validateRoutes(
  diagnostics,
  routes,
  providers,
  { root, checkFiles } = {},
) {
  if (!Array.isArray(routes) || routes.length === 0) {
    diagnostic(diagnostics, 'type', '/routes', 'must be a non-empty array');
    return;
  }
  uniqueIds(diagnostics, routes, '/routes');
  routes.forEach((route, index) => {
    const at = `/routes/${index}`;
    if (
      !exactKeys(diagnostics, route, at, [
        'id',
        'audience',
        'visibility',
        'providers',
        'entrypoints',
      ])
    )
      return;
    stringField(diagnostics, route.id, `${at}/id`, { id: true });
    enumField(diagnostics, route.audience, `${at}/audience`, [
      'human',
      'agent',
    ]);
    enumField(diagnostics, route.visibility, `${at}/visibility`, VISIBILITY);
    if (!Array.isArray(route.providers) || route.providers.length === 0)
      diagnostic(
        diagnostics,
        'type',
        `${at}/providers`,
        'must be a non-empty array',
      );
    else {
      const seen = new Set();
      route.providers.forEach(
        /** @param {unknown} id @param {number} providerIndex */ (
          id,
          providerIndex,
        ) => {
          if (
            !stringField(diagnostics, id, `${at}/providers/${providerIndex}`, {
              id: true,
            })
          )
            return;
          if (seen.has(id))
            diagnostic(
              diagnostics,
              'duplicate-route-provider',
              `${at}/providers/${providerIndex}`,
              `duplicates ${id}`,
            );
          seen.add(id);
          const provider = providers.get(id);
          if (!provider)
            diagnostic(
              diagnostics,
              'unknown-provider',
              `${at}/providers/${providerIndex}`,
              `unknown provider: ${id}`,
            );
          else if (
            provider.lifecycle === 'retired' ||
            ['stale', 'invalidated'].includes(provider.state)
          )
            diagnostic(
              diagnostics,
              'inactive-provider',
              `${at}/providers/${providerIndex}`,
              `${provider.lifecycle}/${provider.state} provider cannot enter a current route`,
            );
          else if (
            (VISIBILITY_RANK.get(route.visibility) ?? -1) <
            (VISIBILITY_RANK.get(provider.visibility) ?? -1)
          )
            diagnostic(
              diagnostics,
              'visibility-broadening',
              `${at}/providers/${providerIndex}`,
              `${provider.visibility} provider cannot enter ${route.visibility} route`,
            );
        },
      );
    }
    if (!Array.isArray(route.entrypoints) || route.entrypoints.length === 0)
      diagnostic(
        diagnostics,
        'type',
        `${at}/entrypoints`,
        'must be a non-empty array',
      );
    else
      route.entrypoints.forEach(
        /** @param {unknown} entrypoint @param {number} entryIndex */ (
          entrypoint,
          entryIndex,
        ) => {
          const entryAt = `${at}/entrypoints/${entryIndex}`;
          if (
            repositoryPath(diagnostics, entrypoint, entryAt) &&
            checkFiles &&
            root
          )
            if (
              !fs.existsSync(path.join(root, entrypoint)) ||
              !fs.statSync(path.join(root, entrypoint)).isFile()
            )
              diagnostic(
                diagnostics,
                'missing-entrypoint',
                entryAt,
                'does not exist',
              );
        },
      );
  });
}

/** @param {Diagnostic[]} diagnostics @param {unknown} policies */
function validatePolicies(diagnostics, policies) {
  if (
    !exactKeys(diagnostics, policies, '/policies', [
      'unknownFields',
      'pathSemantics',
      'providerExecution',
      'receiptAuthority',
      'qualification',
    ])
  )
    return;
  const constants = {
    unknownFields: 'reject',
    pathSemantics: 'repository-relative-posix',
    providerExecution: 'shifu-gate-registry-only',
    receiptAuthority: 'shifu',
    qualification: 'evidence-or-review-obligation',
  };
  for (const [key, expected] of Object.entries(constants))
    if (policies[key] !== expected)
      diagnostic(
        diagnostics,
        key === 'receiptAuthority' ? 'self-certified-receipt' : 'policy',
        `/policies/${key}`,
        `must be ${expected}`,
      );
}

/** @param {JsonObject} submission */
function sortedSubmission(submission) {
  const normalized = structuredClone(submission);
  for (const key of [
    'roots',
    'documentProfiles',
    'verificationProfiles',
    'providers',
    'routes',
  ])
    normalized[key] = [...normalized[key]].sort((left, right) =>
      compareUnicodeCodePoints(left.id, right.id),
    );
  for (const route of normalized.routes) {
    route.providers = [...route.providers].sort(compareUnicodeCodePoints);
    route.entrypoints = [...route.entrypoints].sort(compareUnicodeCodePoints);
  }
  return normalized;
}

/** @param {JsonObject} submission */
export function canonicalizeDocumentationSubmission(submission) {
  const normalized = sortedSubmission(submission);
  const contract = {
    schema: normalized.schema,
    project: normalized.project,
    roots: normalized.roots,
    documentProfiles: normalized.documentProfiles,
    verificationProfiles: normalized.verificationProfiles,
    policies: normalized.policies,
    surfacePolicy: normalized.surfacePolicy || null,
  };
  const content = {
    project: normalized.project,
    providers: normalized.providers,
    routes: normalized.routes,
  };
  return {
    schema: 'shifu.documentation-projection/v1',
    roots: {
      algorithm: 'sha256',
      contract: documentationDigest(contract),
      content: documentationDigest(content),
      submission: documentationDigest(normalized),
    },
    submission: normalized,
  };
}

/** @param {unknown} submission @param {ValidationOptions} [options] */
export function validateDocumentationSubmission(submission, options = {}) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  if (!exactKeys(diagnostics, submission, '', TOP_KEYS, OPTIONAL_TOP_KEYS))
    return { valid: false, diagnostics, projection: null };
  if (submission.$schema !== DOCUMENTATION_SUBMISSION_SCHEMA)
    diagnostic(
      diagnostics,
      'schema-id',
      '/$schema',
      `must be ${DOCUMENTATION_SUBMISSION_SCHEMA}`,
    );
  if (submission.schema !== 'shifu.documentation-project/v1')
    diagnostic(
      diagnostics,
      'schema-version',
      '/schema',
      'must be shifu.documentation-project/v1',
    );
  validateProject(diagnostics, submission.project);
  const roots = validateRoots(diagnostics, submission.roots);
  const documentProfiles = validateDocumentProfiles(
    diagnostics,
    submission.documentProfiles,
  );
  const verificationProfiles = validateVerificationProfiles(
    diagnostics,
    submission.verificationProfiles,
  );
  const providers = validateProviders(
    diagnostics,
    submission.providers,
    roots,
    documentProfiles,
    verificationProfiles,
    options,
  );
  validateRoutes(diagnostics, submission.routes, providers, options);
  validatePolicies(diagnostics, submission.policies);
  if (submission.surfacePolicy !== undefined) {
    if (
      repositoryPath(diagnostics, submission.surfacePolicy, '/surfacePolicy')
    ) {
      if (options.checkFiles && options.root) {
        const resolved = path.join(options.root, submission.surfacePolicy);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
          diagnostic(
            diagnostics,
            'missing-surface-policy',
            '/surfacePolicy',
            'does not exist',
          );
      }
    }
  }
  diagnostics.sort((left, right) =>
    compareUnicodeCodePoints(
      `${left.path}\0${left.code}`,
      `${right.path}\0${right.code}`,
    ),
  );
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    projection:
      diagnostics.length === 0
        ? canonicalizeDocumentationSubmission(submission)
        : null,
  };
}

/** @param {string|Buffer|Uint8Array} raw @param {ValidationOptions} [options] @returns {DocumentationValidationResult} */
export function validateDocumentationSubmissionBytes(raw, options = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let submission;
  try {
    submission = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      submission: null,
      valid: false,
      diagnostics: [
        {
          code: 'json',
          path: '/',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      projection: null,
    };
  }
  return {
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    submission,
    ...validateDocumentationSubmission(submission, options),
  };
}

/** @param {DocumentationValidationResult} result @param {string} ref */
export function documentationValidationReceipt(result, ref) {
  return {
    $schema: DOCUMENTATION_RECEIPT_SCHEMA,
    schema: 'shifu.documentation-validation-receipt/v1',
    submission: { ref, digest: result.digest },
    project: result.submission?.project?.id || null,
    valid: result.valid,
    qualifying: false,
    selfCertified: false,
    roots: result.projection?.roots || null,
    diagnostics: result.diagnostics,
  };
}
