// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';

export const CUT_SCHEMA = 'kungfu.cut/v1';
export const CUT_RECEIPT_SCHEMA = 'kungfu.cut.receipt/v1';
export const ROOT_ALGORITHM = 'sha256-kungfu-cut-canonical-json-v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;
const ISSUE_KEYS = ['code', 'detail', 'path', 'root'];

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasValidUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Canonical JSON used only by the explicitly versioned Core Cut protocol. */
export function canonicalJson(value, at = '$') {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!hasValidUnicodeScalars(value))
      throw Object.assign(new Error(`${at} contains an unpaired surrogate`), {
        code: 'invalid-unicode',
        path: at,
      });
    if (value.normalize('NFC') !== value)
      throw Object.assign(new Error(`${at} must be NFC-normalized`), {
        code: 'non-canonical-unicode',
        path: at,
      });
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw Object.assign(
        new Error(`${at} must be a non-negative safe integer`),
        { code: 'non-canonical-number', path: at },
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry, index) => canonicalJson(entry, `${at}[${index}]`)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(
        ([key, child]) =>
          `${canonicalJson(key, `${at}.<key>`)}:${canonicalJson(child, `${at}.${key}`)}`,
      )
      .join(',')}}`;
  }
  throw Object.assign(new Error(`${at} contains an unsupported JSON value`), {
    code: 'unsupported-json-value',
    path: at,
  });
}

export function semanticRoot(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const diagnostic = (code, path, message) => ({ code, path, message });

function exactKeys(value, expected, at, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an object'));
    return false;
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    diagnostics.push(
      diagnostic('schema-drift', at, `expected fields ${wanted.join(', ')}`),
    );
    return false;
  }
  return true;
}

function requireRoot(value, at, diagnostics, nullable = false) {
  if ((nullable && value === null) || ROOT.test(value)) return;
  diagnostics.push(
    diagnostic('invalid-root', at, 'expected a canonical SHA-256 root'),
  );
}

function requireId(value, at, diagnostics) {
  if (typeof value === 'string' && ID.test(value)) return;
  diagnostics.push(
    diagnostic('invalid-id', at, 'expected a stable lowercase identifier'),
  );
}

function verifyIssues(value, at, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an array'));
    return;
  }
  value.forEach((issue, index) => {
    const path = `${at}[${index}]`;
    if (!exactKeys(issue, ISSUE_KEYS, path, diagnostics)) return;
    requireId(issue.code, `${path}.code`, diagnostics);
    if (typeof issue.path !== 'string' || issue.path.length === 0)
      diagnostics.push(
        diagnostic('invalid-path', `${path}.path`, 'expected a non-empty path'),
      );
    if (typeof issue.detail !== 'string' || issue.detail.length === 0)
      diagnostics.push(
        diagnostic(
          'invalid-detail',
          `${path}.detail`,
          'expected non-empty detail',
        ),
      );
    requireRoot(issue.root, `${path}.root`, diagnostics, true);
  });
}

export function cutRootInput(cut) {
  const { cutRoot: _cutRoot, ...input } = cut;
  return input;
}

export function verifyCut(cut) {
  const diagnostics = [];
  if (
    !exactKeys(
      cut,
      [
        'bindings',
        'cutRoot',
        'episodeDelta',
        'interpretation',
        'parentCutRoots',
        'profile',
        'schema',
        'uncertainty',
      ],
      '$',
      diagnostics,
    )
  )
    return { valid: false, diagnostics };
  if (cut.schema !== CUT_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', `expected ${CUT_SCHEMA}`),
    );
  if (
    exactKeys(
      cut.profile,
      ['displayName', 'id', 'schemaRoot', 'version'],
      '$.profile',
      diagnostics,
    )
  ) {
    requireId(cut.profile.id, '$.profile.id', diagnostics);
    if (!Number.isSafeInteger(cut.profile.version) || cut.profile.version < 1)
      diagnostics.push(
        diagnostic(
          'invalid-version',
          '$.profile.version',
          'expected a positive integer',
        ),
      );
    if (
      typeof cut.profile.displayName !== 'string' ||
      cut.profile.displayName.length === 0
    )
      diagnostics.push(
        diagnostic(
          'invalid-display-name',
          '$.profile.displayName',
          'expected non-empty text',
        ),
      );
    requireRoot(cut.profile.schemaRoot, '$.profile.schemaRoot', diagnostics);
  }
  if (!Array.isArray(cut.parentCutRoots))
    diagnostics.push(
      diagnostic('invalid-type', '$.parentCutRoots', 'expected an array'),
    );
  else {
    cut.parentCutRoots.forEach((root, index) =>
      requireRoot(root, `$.parentCutRoots[${index}]`, diagnostics),
    );
    if (
      [...cut.parentCutRoots].sort().join('\n') !==
      cut.parentCutRoots.join('\n')
    )
      diagnostics.push(
        diagnostic(
          'non-canonical-order',
          '$.parentCutRoots',
          'roots must be sorted',
        ),
      );
    if (new Set(cut.parentCutRoots).size !== cut.parentCutRoots.length)
      diagnostics.push(
        diagnostic(
          'duplicate-entry',
          '$.parentCutRoots',
          'roots must be unique',
        ),
      );
  }
  if (!Array.isArray(cut.bindings) || cut.bindings.length === 0)
    diagnostics.push(
      diagnostic(
        'missing-binding',
        '$.bindings',
        'expected at least one authoritative binding',
      ),
    );
  else {
    cut.bindings.forEach((binding, index) => {
      const at = `$.bindings[${index}]`;
      if (
        !exactKeys(
          binding,
          ['authority', 'root', 'schemaRoot', 'type'],
          at,
          diagnostics,
        )
      )
        return;
      requireId(binding.type, `${at}.type`, diagnostics);
      requireId(binding.authority, `${at}.authority`, diagnostics);
      requireRoot(binding.root, `${at}.root`, diagnostics);
      requireRoot(binding.schemaRoot, `${at}.schemaRoot`, diagnostics);
    });
    const keys = cut.bindings.map(
      (entry) => `${entry.type}\0${entry.authority}`,
    );
    if ([...keys].sort(compareUtf8).join('\n') !== keys.join('\n'))
      diagnostics.push(
        diagnostic(
          'non-canonical-order',
          '$.bindings',
          'bindings must be sorted by type and authority',
        ),
      );
    if (new Set(keys).size !== keys.length)
      diagnostics.push(
        diagnostic(
          'duplicate-entry',
          '$.bindings',
          'binding identities must be unique',
        ),
      );
  }
  if (
    exactKeys(
      cut.episodeDelta,
      ['admitted', 'empty', 'root'],
      '$.episodeDelta',
      diagnostics,
    )
  ) {
    if (
      typeof cut.episodeDelta.admitted !== 'boolean' ||
      typeof cut.episodeDelta.empty !== 'boolean'
    )
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.episodeDelta',
          'admitted and empty must be booleans',
        ),
      );
    requireRoot(
      cut.episodeDelta.root,
      '$.episodeDelta.root',
      diagnostics,
      true,
    );
    if (cut.episodeDelta.empty !== (cut.episodeDelta.root === null))
      diagnostics.push(
        diagnostic(
          'invalid-empty-delta',
          '$.episodeDelta',
          'empty and root must agree',
        ),
      );
    if (!cut.episodeDelta.admitted && !cut.episodeDelta.empty)
      diagnostics.push(
        diagnostic(
          'episode-not-admitted',
          '$.episodeDelta',
          'a non-empty Episode delta must be admitted',
        ),
      );
  }
  if (
    exactKeys(
      cut.interpretation,
      ['policyRoots', 'protocolRoot', 'schemaRoot'],
      '$.interpretation',
      diagnostics,
    )
  ) {
    requireRoot(
      cut.interpretation.protocolRoot,
      '$.interpretation.protocolRoot',
      diagnostics,
    );
    requireRoot(
      cut.interpretation.schemaRoot,
      '$.interpretation.schemaRoot',
      diagnostics,
    );
    if (!Array.isArray(cut.interpretation.policyRoots))
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.interpretation.policyRoots',
          'expected an array',
        ),
      );
    else {
      cut.interpretation.policyRoots.forEach((root, index) =>
        requireRoot(
          root,
          `$.interpretation.policyRoots[${index}]`,
          diagnostics,
        ),
      );
      if (
        [...cut.interpretation.policyRoots].sort().join('\n') !==
        cut.interpretation.policyRoots.join('\n')
      )
        diagnostics.push(
          diagnostic(
            'non-canonical-order',
            '$.interpretation.policyRoots',
            'policy roots must be sorted',
          ),
        );
      if (
        new Set(cut.interpretation.policyRoots).size !==
        cut.interpretation.policyRoots.length
      )
        diagnostics.push(
          diagnostic(
            'duplicate-entry',
            '$.interpretation.policyRoots',
            'policy roots must be unique',
          ),
        );
    }
  }
  if (
    exactKeys(
      cut.uncertainty,
      ['conflicts', 'omissions', 'unknowns'],
      '$.uncertainty',
      diagnostics,
    )
  ) {
    for (const name of ['conflicts', 'omissions', 'unknowns'])
      verifyIssues(cut.uncertainty[name], `$.uncertainty.${name}`, diagnostics);
  }
  requireRoot(cut.cutRoot, '$.cutRoot', diagnostics);
  if (ROOT.test(cut.cutRoot) && semanticRoot(cutRootInput(cut)) !== cut.cutRoot)
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        '$.cutRoot',
        'Cut root does not match canonical preimage',
      ),
    );
  return { valid: diagnostics.length === 0, diagnostics };
}

export function buildCut(input) {
  const cut = {
    schema: CUT_SCHEMA,
    ...input,
    cutRoot: 'sha256:'.padEnd(71, '0'),
  };
  cut.cutRoot = semanticRoot(cutRootInput(cut));
  const verdict = verifyCut(cut);
  if (!verdict.valid)
    throw Object.assign(new Error('invalid Core Cut'), {
      code: 'cut-invalid',
      diagnostics: verdict.diagnostics,
    });
  return cut;
}

export function exportCut(cut) {
  const verdict = verifyCut(cut);
  if (!verdict.valid)
    throw Object.assign(new Error('cannot export an invalid Core Cut'), {
      code: 'cut-invalid',
      diagnostics: verdict.diagnostics,
    });
  return Buffer.from(`${canonicalJson(cut)}\n`, 'utf8');
}

export function importCut(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.endsWith('\n'))
    throw Object.assign(new Error('Cut artifact must end with one newline'), {
      code: 'non-canonical-encoding',
    });
  const cut = JSON.parse(text);
  if (`${canonicalJson(cut)}\n` !== text)
    throw Object.assign(new Error('Cut artifact is not canonical JSON'), {
      code: 'non-canonical-encoding',
    });
  const verdict = verifyCut(cut);
  if (!verdict.valid)
    throw Object.assign(new Error('invalid Core Cut'), {
      code: 'cut-invalid',
      diagnostics: verdict.diagnostics,
    });
  return cut;
}

export function createCutReceipt(cut) {
  const bytes = exportCut(cut);
  const input = {
    schema: CUT_RECEIPT_SCHEMA,
    rootAlgorithm: ROOT_ALGORITHM,
    cutRoot: cut.cutRoot,
    serializationRoot: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  return { ...input, receiptRoot: semanticRoot(input) };
}

export function verifyCutReceipt(cut, receipt) {
  const diagnostics = [];
  if (
    !exactKeys(
      receipt,
      [
        'cutRoot',
        'receiptRoot',
        'rootAlgorithm',
        'schema',
        'serializationRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { valid: false, diagnostics };
  if (receipt.schema !== CUT_RECEIPT_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        `expected ${CUT_RECEIPT_SCHEMA}`,
      ),
    );
  if (receipt.rootAlgorithm !== ROOT_ALGORITHM)
    diagnostics.push(
      diagnostic(
        'unknown-root-algorithm',
        '$.rootAlgorithm',
        `expected ${ROOT_ALGORITHM}`,
      ),
    );
  for (const field of ['cutRoot', 'serializationRoot', 'receiptRoot'])
    requireRoot(receipt[field], `$.${field}`, diagnostics);
  if (verifyCut(cut).valid && receipt.cutRoot !== cut.cutRoot)
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        '$.cutRoot',
        'receipt references another Cut',
      ),
    );
  const { receiptRoot, ...input } = receipt;
  if (ROOT.test(receiptRoot) && semanticRoot(input) !== receiptRoot)
    diagnostics.push(
      diagnostic(
        'receipt-mismatch',
        '$.receiptRoot',
        'receipt root does not match its preimage',
      ),
    );
  if (verifyCut(cut).valid) {
    const expected = createCutReceipt(cut);
    if (receipt.serializationRoot !== expected.serializationRoot)
      diagnostics.push(
        diagnostic(
          'serialization-mismatch',
          '$.serializationRoot',
          'receipt does not bind the canonical artifact bytes',
        ),
      );
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
