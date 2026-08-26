// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import { scanJson } from './json-scanner.mjs';

export const PROJECT_CUT_SCHEMA = 'project.cut/v1';
export const PROJECT_CUT_ROOT_INPUT_SCHEMA = 'project.cut.root-input/v1';
export const PROJECT_CUT_RECEIPT_SCHEMA = 'project.cut.receipt/v1';
export const SOURCE_PROJECTION_SCHEMA = 'project.source-projection/v1';
export const SOURCE_PROJECTION_POLICY_SCHEMA =
  'project.source-projection-policy/v1';
export const ROOT_ALGORITHM = 'sha256-project-cut-canonical-json-v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;
const VISIBILITIES = new Set(['public', 'internal', 'restricted']);
const AUTHORITY_MODES = new Set(['bridge', 'native']);
const RELATION_VERDICTS = new Set([
  'equal',
  'different',
  'unsupported',
  'unverifiable',
]);

/** @typedef {{code: string, path: string, message: string}} Diagnostic */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Canonical JSON for Project Cut roots. Objects are ordered by UTF-8 key bytes;
 * arrays retain their declared order. Only NFC strings and safe integers are
 * admitted so another implementation never has to guess number or text rules.
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string}
 */
export function canonicalJson(value, at = '$') {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!hasValidUnicodeScalars(value)) {
      throw Object.assign(new Error(`${at} contains an unpaired surrogate`), {
        code: 'invalid-unicode',
        path: at,
      });
    }
    if (value.normalize('NFC') !== value) {
      throw Object.assign(new Error(`${at} must be NFC-normalized`), {
        code: 'non-canonical-unicode',
        path: at,
      });
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw Object.assign(
        new Error(`${at} must be a non-negative safe integer`),
        {
          code: 'non-canonical-number',
          path: at,
        },
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => canonicalJson(entry, `${at}[${index}]`))
      .join(',')}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      utf8Compare(left, right),
    );
    return `{${entries
      .map(([key, child]) => {
        canonicalJson(key, `${at}.<key>`);
        return `${JSON.stringify(key)}:${canonicalJson(child, `${at}.${key}`)}`;
      })
      .join(',')}}`;
  }
  throw Object.assign(new Error(`${at} contains an unsupported JSON value`), {
    code: 'unsupported-json-value',
    path: at,
  });
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function semanticRoot(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

/**
 * Parse UTF-8 JSON for a rooted object without losing duplicate-key evidence.
 * The returned object may use any field order; canonicalJson defines its root.
 * @param {string | Uint8Array} input
 * @returns {unknown}
 */
export function parseRootJson(input) {
  let text;
  if (typeof input === 'string') {
    text = input;
  } else {
    const bytes = Buffer.from(input);
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    )
      throw Object.assign(new Error('UTF-8 BOM is not admitted'), {
        code: 'non-canonical-encoding',
        path: '$',
      });
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw Object.assign(new Error('input is not valid UTF-8'), {
        code: 'non-canonical-encoding',
        path: '$',
      });
    }
  }
  if (text.startsWith('\uFEFF'))
    throw Object.assign(new Error('Unicode BOM is not admitted'), {
      code: 'non-canonical-encoding',
      path: '$',
    });
  const parsed = scanJson(text);
  canonicalJson(parsed);
  return parsed;
}

/**
 * Parse JSON while preserving non-negative integer tokens above JavaScript's
 * safe range as BigInt. Callers must apply a domain-specific canonicalizer;
 * Project Cut roots themselves continue to admit safe integers only.
 * @param {string | Uint8Array} input
 * @returns {unknown}
 */
export function parseLosslessUint64Json(input) {
  const text =
    typeof input === 'string'
      ? input
      : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input));
  if (text.startsWith('\uFEFF'))
    throw Object.assign(new Error('Unicode BOM is not admitted'), {
      code: 'non-canonical-encoding',
      path: '$',
    });
  return scanJson(text, { losslessUint64: true });
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function sortedDiagnostics(items) {
  return items.sort(
    (left, right) =>
      utf8Compare(left.path, right.path) || utf8Compare(left.code, right.code),
  );
}

function exactKeys(value, allowed, required, at, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an object'));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostics.push(
        diagnostic(
          'unknown-field',
          `${at}.${key}`,
          'field is not in this schema',
        ),
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      diagnostics.push(
        diagnostic(
          'missing-field',
          `${at}.${key}`,
          'required field is missing',
        ),
      );
    }
  }
  return true;
}

function requireString(value, at, diagnostics, pattern = null) {
  if (typeof value !== 'string' || value.length === 0) {
    diagnostics.push(
      diagnostic('invalid-type', at, 'expected a non-empty string'),
    );
    return false;
  }
  if (!hasValidUnicodeScalars(value) || value.normalize('NFC') !== value) {
    diagnostics.push(
      diagnostic(
        'non-canonical-unicode',
        at,
        'string must be valid NFC Unicode',
      ),
    );
    return false;
  }
  if (pattern && !pattern.test(value)) {
    diagnostics.push(
      diagnostic('invalid-value', at, 'string has an invalid format'),
    );
    return false;
  }
  return true;
}

function requireRoot(value, at, diagnostics) {
  return requireString(value, at, diagnostics, ROOT);
}

function requireRootArray(value, at, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an array'));
    return;
  }
  value.forEach((entry, index) =>
    requireRoot(entry, `${at}[${index}]`, diagnostics),
  );
  requireSortedUnique(value, at, diagnostics, (entry) => String(entry));
}

function requireSortedUnique(value, at, diagnostics, keyOf) {
  if (!Array.isArray(value)) return;
  for (let index = 1; index < value.length; index += 1) {
    const previous = keyOf(value[index - 1]);
    const current = keyOf(value[index]);
    const order = utf8Compare(previous, current);
    if (order === 0) {
      diagnostics.push(
        diagnostic(
          'duplicate-entry',
          `${at}[${index}]`,
          'array entries must be unique',
        ),
      );
    } else if (order > 0) {
      diagnostics.push(
        diagnostic(
          'non-canonical-order',
          `${at}[${index}]`,
          'array must be sorted by UTF-8 bytes',
        ),
      );
    }
  }
}

function validatePath(value, at, diagnostics) {
  if (!requireString(value, at, diagnostics)) return false;
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    diagnostics.push(
      diagnostic(
        'invalid-path',
        at,
        'path must be an NFC POSIX-relative path without dot segments',
      ),
    );
    return false;
  }
  return true;
}

function matchesPrefix(path, prefix) {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function validatePolicy(policy, diagnostics, at = '$.policy') {
  if (
    !exactKeys(
      policy,
      [
        'schema',
        'id',
        'pathNormalization',
        'entryOrder',
        'excludePrefixes',
        'privacyDenyPrefixes',
        'protocolOutputPrefixes',
        'policyRoot',
      ],
      [
        'schema',
        'id',
        'pathNormalization',
        'entryOrder',
        'excludePrefixes',
        'privacyDenyPrefixes',
        'protocolOutputPrefixes',
        'policyRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (policy.schema !== SOURCE_PROJECTION_POLICY_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        `${at}.schema`,
        'unsupported policy schema',
      ),
    );
  requireString(policy.id, `${at}.id`, diagnostics, PROJECT_ID);
  if (policy.pathNormalization !== 'utf8-nfc-posix-relative/v1')
    diagnostics.push(
      diagnostic(
        'unsupported-policy',
        `${at}.pathNormalization`,
        'unsupported path normalization policy',
      ),
    );
  if (policy.entryOrder !== 'utf8-bytewise-path/v1')
    diagnostics.push(
      diagnostic(
        'unsupported-policy',
        `${at}.entryOrder`,
        'unsupported entry ordering policy',
      ),
    );
  for (const key of [
    'excludePrefixes',
    'privacyDenyPrefixes',
    'protocolOutputPrefixes',
  ]) {
    const entries = policy[key];
    if (!Array.isArray(entries)) {
      diagnostics.push(
        diagnostic('invalid-type', `${at}.${key}`, 'expected an array'),
      );
      continue;
    }
    entries.forEach((entry, index) =>
      validatePath(entry, `${at}.${key}[${index}]`, diagnostics),
    );
    requireSortedUnique(entries, `${at}.${key}`, diagnostics, (entry) =>
      String(entry),
    );
  }
  requireRoot(policy.policyRoot, `${at}.policyRoot`, diagnostics);
  if (isObject(policy)) {
    const { policyRoot, ...preimage } = policy;
    try {
      if (
        ROOT.test(String(policyRoot)) &&
        semanticRoot(preimage) !== policyRoot
      ) {
        diagnostics.push(
          diagnostic(
            'root-mismatch',
            `${at}.policyRoot`,
            'policy root does not match',
          ),
        );
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error?.code ?? 'canonicalization-failed',
          error?.path ?? at,
          String(error.message),
        ),
      );
    }
  }
}

export function verifySourceProjection(projection, policy) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  validatePolicy(policy, diagnostics);
  if (
    !exactKeys(
      projection,
      ['schema', 'projectId', 'policyRoot', 'entries', 'omissions', 'root'],
      ['schema', 'projectId', 'policyRoot', 'entries', 'omissions', 'root'],
      '$',
      diagnostics,
    )
  )
    return { valid: false, diagnostics: sortedDiagnostics(diagnostics) };
  if (projection.schema !== SOURCE_PROJECTION_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported source projection schema',
      ),
    );
  requireString(projection.projectId, '$.projectId', diagnostics, PROJECT_ID);
  requireRoot(projection.policyRoot, '$.policyRoot', diagnostics);
  if (projection.policyRoot !== policy?.policyRoot)
    diagnostics.push(
      diagnostic(
        'policy-drift',
        '$.policyRoot',
        'projection policy root differs',
      ),
    );
  if (!Array.isArray(projection.entries)) {
    diagnostics.push(
      diagnostic('invalid-type', '$.entries', 'expected an array'),
    );
  } else {
    projection.entries.forEach((entry, index) => {
      const at = `$.entries[${index}]`;
      if (
        !exactKeys(
          entry,
          ['path', 'kind', 'visibility', 'digest', 'size'],
          ['path', 'kind', 'visibility', 'digest', 'size'],
          at,
          diagnostics,
        )
      )
        return;
      if (validatePath(entry.path, `${at}.path`, diagnostics)) {
        for (const prefix of policy?.privacyDenyPrefixes ?? []) {
          if (matchesPrefix(entry.path, prefix))
            diagnostics.push(
              diagnostic(
                'privacy-denied',
                `${at}.path`,
                'private path cannot be projected',
              ),
            );
        }
        for (const prefix of policy?.protocolOutputPrefixes ?? []) {
          if (matchesPrefix(entry.path, prefix))
            diagnostics.push(
              diagnostic(
                'generated-feedback',
                `${at}.path`,
                'Project Cut output cannot feed the same source projection',
              ),
            );
        }
        for (const prefix of policy?.excludePrefixes ?? []) {
          if (matchesPrefix(entry.path, prefix))
            diagnostics.push(
              diagnostic(
                'excluded-path',
                `${at}.path`,
                'path is excluded by policy',
              ),
            );
        }
      }
      if (!['source', 'authority'].includes(entry.kind))
        diagnostics.push(
          diagnostic('invalid-value', `${at}.kind`, 'unknown entry kind'),
        );
      if (!VISIBILITIES.has(entry.visibility))
        diagnostics.push(
          diagnostic('invalid-value', `${at}.visibility`, 'unknown visibility'),
        );
      requireRoot(entry.digest, `${at}.digest`, diagnostics);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0)
        diagnostics.push(
          diagnostic(
            'non-canonical-number',
            `${at}.size`,
            'size must be a safe integer',
          ),
        );
    });
    requireSortedUnique(projection.entries, '$.entries', diagnostics, (entry) =>
      String(entry?.path),
    );
  }
  if (!Array.isArray(projection.omissions)) {
    diagnostics.push(
      diagnostic('invalid-type', '$.omissions', 'expected an array'),
    );
  } else {
    projection.omissions.forEach((entry, index) => {
      const at = `$.omissions[${index}]`;
      if (
        !exactKeys(
          entry,
          ['path', 'reason', 'visibility'],
          ['path', 'reason', 'visibility'],
          at,
          diagnostics,
        )
      )
        return;
      validatePath(entry.path, `${at}.path`, diagnostics);
      requireString(entry.reason, `${at}.reason`, diagnostics);
      if (!VISIBILITIES.has(entry.visibility))
        diagnostics.push(
          diagnostic('invalid-value', `${at}.visibility`, 'unknown visibility'),
        );
    });
    requireSortedUnique(
      projection.omissions,
      '$.omissions',
      diagnostics,
      (entry) => `${entry?.path}\0${entry?.reason}`,
    );
  }
  requireRoot(projection.root, '$.root', diagnostics);
  if (isObject(projection)) {
    const { root, ...preimage } = projection;
    try {
      if (ROOT.test(String(root)) && semanticRoot(preimage) !== root)
        diagnostics.push(
          diagnostic(
            'root-mismatch',
            '$.root',
            'projection root does not match',
          ),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error?.code ?? 'canonicalization-failed',
          error?.path ?? '$',
          String(error.message),
        ),
      );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: sortedDiagnostics(diagnostics),
  };
}

export function buildSourceProjection(input, policy) {
  const policyValue = structuredClone(policy);
  const { policyRoot: _policyRoot, ...policyPreimage } = policyValue;
  policyValue.policyRoot = semanticRoot(policyPreimage);
  const preimage = {
    schema: SOURCE_PROJECTION_SCHEMA,
    projectId: input.projectId,
    policyRoot: policyValue.policyRoot,
    entries: structuredClone(input.entries ?? []),
    omissions: structuredClone(input.omissions ?? []),
  };
  const projection = { ...preimage, root: semanticRoot(preimage) };
  const result = verifySourceProjection(projection, policyValue);
  if (!result.valid) throw validationError(result.diagnostics);
  return { policy: policyValue, projection };
}

function validateIssueArray(value, at, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an array'));
    return;
  }
  value.forEach((entry, index) => {
    const itemAt = `${at}[${index}]`;
    if (
      !exactKeys(
        entry,
        ['code', 'path', 'root', 'detail'],
        ['code', 'path', 'root', 'detail'],
        itemAt,
        diagnostics,
      )
    )
      return;
    requireString(entry.code, `${itemAt}.code`, diagnostics, PROJECT_ID);
    requireString(entry.path, `${itemAt}.path`, diagnostics);
    if (entry.root !== null)
      requireRoot(entry.root, `${itemAt}.root`, diagnostics);
    requireString(entry.detail, `${itemAt}.detail`, diagnostics);
  });
  requireSortedUnique(
    value,
    at,
    diagnostics,
    (entry) => `${entry?.path}\0${entry?.code}\0${entry?.root ?? ''}`,
  );
}

function projectCutRootInput(cut) {
  return {
    schema: PROJECT_CUT_ROOT_INPUT_SCHEMA,
    project: cut.project,
    parentCutRoots: cut.parentCutRoots,
    sourceProjection: cut.sourceProjection,
    atlas: cut.atlas,
    episodeDelta: cut.episodeDelta,
    interpretation: cut.interpretation,
    visibility: cut.visibility,
    omissions: cut.omissions,
    conflicts: cut.conflicts,
    unknowns: cut.unknowns,
    compatibility: cut.compatibility,
  };
}

export function verifyProjectCut(cut, options = {}) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  if (
    !exactKeys(
      cut,
      [
        'schema',
        'project',
        'parentCutRoots',
        'sourceProjection',
        'atlas',
        'episodeDelta',
        'interpretation',
        'visibility',
        'omissions',
        'conflicts',
        'unknowns',
        'compatibility',
        'cutRoot',
      ],
      [
        'schema',
        'project',
        'parentCutRoots',
        'sourceProjection',
        'atlas',
        'episodeDelta',
        'interpretation',
        'visibility',
        'omissions',
        'conflicts',
        'unknowns',
        'compatibility',
        'cutRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { valid: false, diagnostics: sortedDiagnostics(diagnostics) };
  if (cut.schema !== PROJECT_CUT_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported Project Cut schema',
      ),
    );

  if (
    exactKeys(
      cut.project,
      ['id', 'identityRoot'],
      ['id', 'identityRoot'],
      '$.project',
      diagnostics,
    )
  ) {
    requireString(cut.project.id, '$.project.id', diagnostics, PROJECT_ID);
    requireRoot(
      cut.project.identityRoot,
      '$.project.identityRoot',
      diagnostics,
    );
  }
  requireRootArray(cut.parentCutRoots, '$.parentCutRoots', diagnostics);
  if (
    Array.isArray(cut.parentCutRoots) &&
    cut.parentCutRoots.includes(cut.cutRoot)
  )
    diagnostics.push(
      diagnostic(
        'cycle',
        '$.parentCutRoots',
        'a Project Cut cannot be its own parent',
      ),
    );
  if (options.availableParentRoots && Array.isArray(cut.parentCutRoots)) {
    const available = new Set(options.availableParentRoots);
    cut.parentCutRoots.forEach((root, index) => {
      if (!available.has(root))
        diagnostics.push(
          diagnostic(
            'parent-mismatch',
            `$.parentCutRoots[${index}]`,
            'parent cut is not available in the declared settlement scope',
          ),
        );
    });
  }

  for (const [key, schema] of [
    ['sourceProjection', 'project.source-projection-ref/v1'],
    ['atlas', 'xinfa.atlas-ref/v1'],
  ]) {
    const value = cut[key];
    if (
      exactKeys(
        value,
        key === 'sourceProjection'
          ? ['schema', 'root', 'policyRoot']
          : ['schema', 'root', 'compilerRoot'],
        key === 'sourceProjection'
          ? ['schema', 'root', 'policyRoot']
          : ['schema', 'root', 'compilerRoot'],
        `$.${key}`,
        diagnostics,
      )
    ) {
      if (value.schema !== schema)
        diagnostics.push(
          diagnostic(
            'unknown-version',
            `$.${key}.schema`,
            `expected ${schema}`,
          ),
        );
      requireRoot(value.root, `$.${key}.root`, diagnostics);
      requireRoot(
        key === 'sourceProjection' ? value.policyRoot : value.compilerRoot,
        `$.${key}.${key === 'sourceProjection' ? 'policyRoot' : 'compilerRoot'}`,
        diagnostics,
      );
    }
  }

  if (
    exactKeys(
      cut.episodeDelta,
      [
        'schema',
        'empty',
        'nativeRoots',
        'semanticRoot',
        'equivalenceProfileRoot',
      ],
      [
        'schema',
        'empty',
        'nativeRoots',
        'semanticRoot',
        'equivalenceProfileRoot',
      ],
      '$.episodeDelta',
      diagnostics,
    )
  ) {
    if (cut.episodeDelta.schema !== 'kungfu.episode-delta-ref/v1')
      diagnostics.push(
        diagnostic(
          'unknown-version',
          '$.episodeDelta.schema',
          'unsupported Episode delta schema',
        ),
      );
    if (typeof cut.episodeDelta.empty !== 'boolean')
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.episodeDelta.empty',
          'expected a boolean',
        ),
      );
    if (!Array.isArray(cut.episodeDelta.nativeRoots)) {
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.episodeDelta.nativeRoots',
          'expected an array',
        ),
      );
    } else {
      cut.episodeDelta.nativeRoots.forEach((entry, index) => {
        const at = `$.episodeDelta.nativeRoots[${index}]`;
        if (
          !exactKeys(
            entry,
            ['provider', 'root'],
            ['provider', 'root'],
            at,
            diagnostics,
          )
        )
          return;
        requireString(
          entry.provider,
          `${at}.provider`,
          diagnostics,
          PROJECT_ID,
        );
        requireRoot(entry.root, `${at}.root`, diagnostics);
        if (
          options.expectedProviderRoots?.[entry.provider] &&
          options.expectedProviderRoots[entry.provider] !== entry.root
        )
          diagnostics.push(
            diagnostic(
              'provider-drift',
              `${at}.root`,
              'provider root differs from evidence',
            ),
          );
      });
      requireSortedUnique(
        cut.episodeDelta.nativeRoots,
        '$.episodeDelta.nativeRoots',
        diagnostics,
        (entry) => String(entry?.provider),
      );
      if (cut.episodeDelta.empty && cut.episodeDelta.nativeRoots.length !== 0)
        diagnostics.push(
          diagnostic(
            'invalid-empty-delta',
            '$.episodeDelta.nativeRoots',
            'empty delta cannot contain provider roots',
          ),
        );
      if (!cut.episodeDelta.empty && cut.episodeDelta.nativeRoots.length === 0)
        diagnostics.push(
          diagnostic(
            'missing-root',
            '$.episodeDelta.nativeRoots',
            'non-empty delta requires a provider-native root',
          ),
        );
    }
    for (const key of ['semanticRoot', 'equivalenceProfileRoot']) {
      if (cut.episodeDelta[key] !== null)
        requireRoot(
          cut.episodeDelta[key],
          `$.episodeDelta.${key}`,
          diagnostics,
        );
    }
    if (
      (cut.episodeDelta.semanticRoot === null) !==
      (cut.episodeDelta.equivalenceProfileRoot === null)
    )
      diagnostics.push(
        diagnostic(
          'unqualified-equivalence',
          '$.episodeDelta',
          'semantic root and equivalence profile root must appear together',
        ),
      );
  }

  if (
    exactKeys(
      cut.interpretation,
      ['schemaRoot', 'protocolRoot', 'policyRoots', 'providerRoots'],
      ['schemaRoot', 'protocolRoot', 'policyRoots', 'providerRoots'],
      '$.interpretation',
      diagnostics,
    )
  ) {
    requireRoot(
      cut.interpretation.schemaRoot,
      '$.interpretation.schemaRoot',
      diagnostics,
    );
    requireRoot(
      cut.interpretation.protocolRoot,
      '$.interpretation.protocolRoot',
      diagnostics,
    );
    requireRootArray(
      cut.interpretation.policyRoots,
      '$.interpretation.policyRoots',
      diagnostics,
    );
    requireRootArray(
      cut.interpretation.providerRoots,
      '$.interpretation.providerRoots',
      diagnostics,
    );
    if (
      options.expectedSchemaRoot &&
      cut.interpretation.schemaRoot !== options.expectedSchemaRoot
    )
      diagnostics.push(
        diagnostic(
          'schema-drift',
          '$.interpretation.schemaRoot',
          'schema bundle root differs',
        ),
      );
    if (
      options.expectedProtocolRoot &&
      cut.interpretation.protocolRoot !== options.expectedProtocolRoot
    )
      diagnostics.push(
        diagnostic(
          'protocol-drift',
          '$.interpretation.protocolRoot',
          'protocol root differs',
        ),
      );
  }
  if (!VISIBILITIES.has(cut.visibility))
    diagnostics.push(
      diagnostic('invalid-value', '$.visibility', 'unknown visibility'),
    );
  validateIssueArray(cut.omissions, '$.omissions', diagnostics);
  validateIssueArray(cut.conflicts, '$.conflicts', diagnostics);
  validateIssueArray(cut.unknowns, '$.unknowns', diagnostics);

  if (
    exactKeys(
      cut.compatibility,
      ['existingRootsPreserved', 'authorityMode', 'relations'],
      ['existingRootsPreserved', 'authorityMode', 'relations'],
      '$.compatibility',
      diagnostics,
    )
  ) {
    if (cut.compatibility.existingRootsPreserved !== true)
      diagnostics.push(
        diagnostic(
          'root-reinterpretation',
          '$.compatibility.existingRootsPreserved',
          'v1 cannot reinterpret an existing root',
        ),
      );
    if (!AUTHORITY_MODES.has(cut.compatibility.authorityMode))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          '$.compatibility.authorityMode',
          'unknown authority mode',
        ),
      );
    if (!Array.isArray(cut.compatibility.relations)) {
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.compatibility.relations',
          'expected an array',
        ),
      );
    } else {
      cut.compatibility.relations.forEach((entry, index) => {
        const at = `$.compatibility.relations[${index}]`;
        if (
          !exactKeys(
            entry,
            ['leftRoot', 'rightRoot', 'profileRoot', 'verdict'],
            ['leftRoot', 'rightRoot', 'profileRoot', 'verdict'],
            at,
            diagnostics,
          )
        )
          return;
        requireRoot(entry.leftRoot, `${at}.leftRoot`, diagnostics);
        requireRoot(entry.rightRoot, `${at}.rightRoot`, diagnostics);
        if (entry.profileRoot !== null)
          requireRoot(entry.profileRoot, `${at}.profileRoot`, diagnostics);
        if (!RELATION_VERDICTS.has(entry.verdict))
          diagnostics.push(
            diagnostic('invalid-value', `${at}.verdict`, 'unknown verdict'),
          );
        if (entry.verdict === 'equal' && entry.profileRoot === null)
          diagnostics.push(
            diagnostic(
              'unqualified-equivalence',
              `${at}.profileRoot`,
              'equal roots require an equivalence profile',
            ),
          );
      });
      requireSortedUnique(
        cut.compatibility.relations,
        '$.compatibility.relations',
        diagnostics,
        (entry) => `${entry?.leftRoot}\0${entry?.rightRoot}`,
      );
    }
  }
  requireRoot(cut.cutRoot, '$.cutRoot', diagnostics);
  if (ROOT.test(String(cut.cutRoot))) {
    try {
      if (semanticRoot(projectCutRootInput(cut)) !== cut.cutRoot)
        diagnostics.push(
          diagnostic('root-mismatch', '$.cutRoot', 'Project Cut root differs'),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error?.code ?? 'canonicalization-failed',
          error?.path ?? '$',
          String(error.message),
        ),
      );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: sortedDiagnostics(diagnostics),
  };
}

export function buildProjectCut(input, options = {}) {
  const value = structuredClone(input);
  value.schema = PROJECT_CUT_SCHEMA;
  const cut = {
    ...value,
    cutRoot: semanticRoot(projectCutRootInput(value)),
  };
  const result = verifyProjectCut(cut, options);
  if (!result.valid) throw validationError(result.diagnostics);
  return cut;
}

export function createProjectCutReceipt(
  cut,
  artifactBytes = null,
  options = {},
) {
  const result = verifyProjectCut(cut, options);
  const canonicalArtifact = Buffer.from(`${canonicalJson(cut)}\n`, 'utf8');
  const bytes =
    artifactBytes === null ? canonicalArtifact : Buffer.from(artifactBytes);
  const input = {
    schema: PROJECT_CUT_RECEIPT_SCHEMA,
    cutRoot: cut.cutRoot,
    rootAlgorithm: ROOT_ALGORITHM,
    serializationRoot: semanticRoot(cut),
    artifactDigest: sha256Bytes(bytes),
    schemaRoot: cut.interpretation?.schemaRoot ?? null,
    verdict: result.valid ? 'valid' : 'invalid',
    diagnostics: result.diagnostics,
    publication: null,
  };
  return { ...input, receiptRoot: semanticRoot(input) };
}

export function verifyProjectCutReceipt(
  receipt,
  cut,
  artifactBytes = null,
  options = {},
) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const receiptKeys = [
    'schema',
    'cutRoot',
    'rootAlgorithm',
    'serializationRoot',
    'artifactDigest',
    'schemaRoot',
    'verdict',
    'diagnostics',
    'publication',
    'receiptRoot',
  ];
  if (!exactKeys(receipt, receiptKeys, receiptKeys, '$', diagnostics))
    return { valid: false, diagnostics: sortedDiagnostics(diagnostics) };
  const expected = createProjectCutReceipt(cut, artifactBytes, options);
  for (const key of receiptKeys) {
    try {
      if (canonicalJson(receipt[key]) !== canonicalJson(expected[key]))
        diagnostics.push(
          diagnostic('receipt-mismatch', `$.${key}`, 'receipt field differs'),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error?.code ?? 'canonicalization-failed',
          error?.path ?? `$.${key}`,
          String(error.message),
        ),
      );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: sortedDiagnostics(diagnostics),
  };
}

function validationError(diagnostics) {
  return Object.assign(
    new Error(diagnostics.map((item) => item.code).join(', ')),
    {
      code: 'project-cut-invalid',
      diagnostics,
    },
  );
}
