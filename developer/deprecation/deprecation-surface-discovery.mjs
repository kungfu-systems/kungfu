// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_DIALECTS = new Map([
  ['cpp-deprecated-attribute', 'text'],
  ['python-deprecation-warning', 'text'],
  ['js-ts-jsdoc', 'text'],
  ['persisted-schema-protocol', 'text'],
  ['document-frontmatter', 'document'],
  ['cli-structured-compatibility', 'structured'],
  ['kfx-structured-compatibility', 'structured'],
  ['artifact-structured-compatibility', 'structured'],
]);
const CLASSIFICATIONS = new Set(['generated-code', 'historical-evidence']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.kungfu',
  '.venv',
  '.xinfa',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);
const BINDING =
  /kungfu-deprecation:([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)#([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gu;

/** @param {unknown} value */
function objects(value) {
  return Array.isArray(value) &&
    value.every(
      (item) => item && typeof item === 'object' && !Array.isArray(item),
    )
    ? value
    : [];
}

/** @param {unknown} value */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [];
}

/** @param {unknown} value */
function hashJson(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

/** @param {string} value */
function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

/** @param {string} root @param {string} absolute */
function relativePath(root, absolute) {
  return normalizePath(path.relative(root, absolute));
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {unknown} document @param {string} pointer */
function jsonPointer(document, pointer) {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current = document;
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

/** @param {string} root */
function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** @param {string} text @param {number} offset */
function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/** @param {string} text */
function bindingFromText(text) {
  const matches = [...text.matchAll(BINDING)];
  if (matches.length !== 1) return null;
  return { entryId: matches[0][1], markerId: matches[0][2] };
}

/** @param {unknown} value */
function bindingFromRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entryId = String(value.deprecationEntry || '');
  const markerId = String(value.deprecationMarker || '');
  return entryId && markerId ? { entryId, markerId } : null;
}

/** @param {string} text */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line);
    if (pair) values[pair[1]] = pair[2].replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

/**
 * @param {string} dialect
 * @param {string} text
 * @returns {{offset: number, raw: string, binding: {entryId: string, markerId: string} | null}[]}
 */
function textMarkers(dialect, text) {
  let pattern;
  if (dialect === 'cpp-deprecated-attribute') {
    pattern = /\[\[\s*deprecated(?:\s*\(\s*(?:"[^"]*"\s*)+\))?\s*\]\]/gmu;
  } else if (dialect === 'python-deprecation-warning') {
    pattern =
      /\b(?:warnings\.)?warn\s*\([\s\S]{0,500}?\bDeprecationWarning\b[\s\S]{0,500}?\)/gmu;
  } else if (dialect === 'js-ts-jsdoc') {
    pattern = /^\s*\*\s*@deprecated\b.*$/gmu;
  } else if (dialect === 'persisted-schema-protocol') {
    pattern = /^.*(?:\bdeprecated\s*[:=]\s*true\b|\(\s*deprecated\s*\)).*$/gmu;
  } else {
    return [];
  }
  return [...text.matchAll(pattern)].map((match) => ({
    offset: match.index,
    raw: match[0].trim(),
    binding: bindingFromText(match[0]),
  }));
}

function validateDialects(contract, add) {
  const dialectIds = new Set();
  for (const dialect of objects(contract.dialects)) {
    if (!SUPPORTED_DIALECTS.has(dialect.id)) {
      add(`unknown detector dialect: ${String(dialect.id || '<missing>')}`);
      continue;
    }
    if (dialectIds.has(dialect.id))
      add(`duplicate detector dialect: ${dialect.id}`);
    dialectIds.add(dialect.id);
    if (SUPPORTED_DIALECTS.get(dialect.id) !== dialect.kind)
      add(
        `${dialect.id}: detector kind must be ${SUPPORTED_DIALECTS.get(dialect.id)}`,
      );
    if (dialect.kind === 'structured') continue;
    if (strings(dialect.roots).length === 0)
      add(`${dialect.id}: roots must not be empty`);
    if (strings(dialect.extensions).length === 0)
      add(`${dialect.id}: extensions must not be empty`);
  }
  for (const id of SUPPORTED_DIALECTS.keys()) {
    if (!dialectIds.has(id)) add(`required detector dialect is absent: ${id}`);
  }
  return dialectIds;
}

function validateStructuredSources(contract, dialectIds, add) {
  for (const source of objects(contract.structuredSources)) {
    if (
      !dialectIds.has(source.dialect) ||
      SUPPORTED_DIALECTS.get(source.dialect) !== 'structured'
    )
      add(
        `structured source uses unknown structured dialect: ${String(source.dialect || '<missing>')}`,
      );
    if (!['exact', 'basename', 'suffix'].includes(source.match))
      add(`${source.dialect}: structured source match is unsupported`);
    if (!['array-records', 'optional-record'].includes(source.mode))
      add(`${source.dialect}: structured source mode is unsupported`);
    if (source.match === 'exact' && !source.path)
      add(`${source.dialect}: exact structured source needs a path`);
    if (source.match !== 'exact' && strings(source.roots).length === 0)
      add(`${source.dialect}: structured source roots must not be empty`);
  }
}

function validateExclusionPath(exclusion, exclusionPath, add) {
  if (!['exact', 'prefix'].includes(exclusion.match))
    add(`${exclusion.path || '<missing>'}: exclusion match is unsupported`);
  if (
    !exclusionPath ||
    path.isAbsolute(exclusionPath) ||
    exclusionPath.includes('..')
  )
    add(
      `${exclusionPath || '<missing>'}: exclusion path must be repository-relative`,
    );
  if (
    exclusion.match === 'prefix' &&
    (!exclusionPath.endsWith('/') ||
      !exclusionPath.split('/').includes('generated') ||
      exclusionPath.split('/').filter(Boolean).length < 4)
  )
    add(
      `${exclusionPath}: prefix exclusion must target one narrow generated subtree`,
    );
  if (exclusion.match === 'exact' && exclusionPath.endsWith('/'))
    add(`${exclusionPath}: exact exclusion must target one file`);
}

function validateExclusions(contract, dialectIds, add) {
  for (const exclusion of objects(contract.exclusions)) {
    if (!CLASSIFICATIONS.has(exclusion.classification))
      add(
        `exclusion has unknown classification: ${String(exclusion.classification || '<missing>')}`,
      );
    const exclusionPath = String(exclusion.path || '');
    validateExclusionPath(exclusion, exclusionPath, add);
    if (!String(exclusion.reason || '').trim())
      add(
        `${exclusionPath || '<missing>'}: exclusion needs a reviewable reason`,
      );
    for (const dialect of strings(exclusion.dialects)) {
      if (!dialectIds.has(dialect))
        add(`${exclusionPath}: exclusion uses unknown dialect ${dialect}`);
    }
    if (strings(exclusion.dialects).length === 0)
      add(
        `${exclusionPath || '<missing>'}: exclusion dialects must not be empty`,
      );
  }
}

/**
 * @param {any} contract
 * @returns {{ok: boolean, findings: {code: string, entry: null, message: string}[]}}
 */
export function validateDiscoveryContract(contract) {
  const findings = [];
  const add = (message) =>
    findings.push({
      code: 'deprecation-discovery-contract',
      entry: null,
      message,
    });
  if (contract.schema !== 'kungfu.deprecation-discovery.contract/v1') {
    add('unsupported deprecation discovery contract schema');
  }
  if (contract.projectionSchema !== 'kungfu.deprecation-inventory/v1') {
    add('unsupported deprecation inventory projection schema');
  }
  const dialectIds = validateDialects(contract, add);
  validateStructuredSources(contract, dialectIds, add);
  validateExclusions(contract, dialectIds, add);
  return { ok: findings.length === 0, findings };
}

/** @param {any} exclusion @param {string} file @param {string} dialect */
function exclusionMatches(exclusion, file, dialect) {
  if (!strings(exclusion.dialects).includes(dialect)) return false;
  return exclusion.match === 'exact'
    ? file === exclusion.path
    : file.startsWith(exclusion.path);
}

/** @param {any} source @param {string} file */
function structuredSourceMatches(source, file) {
  if (source.match === 'exact') return file === source.path;
  const inRoot = strings(source.roots).some(
    (root) => file === root || file.startsWith(`${root}/`),
  );
  if (!inRoot) return false;
  if (source.match === 'basename')
    return path.posix.basename(file) === source.basename;
  return file.endsWith(String(source.suffix || ''));
}

/**
 * @param {{root: string, contract: any, changedFiles?: string[]}} options
 */
function discoveryCandidates(root, contract, changedFiles) {
  const candidates = new Set();
  if (changedFiles) {
    for (const file of changedFiles) {
      const absolute = path.join(root, file);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile())
        candidates.add(file);
    }
    return candidates;
  }

  const roots = new Set();
  for (const dialect of objects(contract.dialects)) {
    for (const scanRoot of strings(dialect.roots)) roots.add(scanRoot);
  }
  for (const source of objects(contract.structuredSources)) {
    if (source.match === 'exact') candidates.add(normalizePath(source.path));
    else for (const scanRoot of strings(source.roots)) roots.add(scanRoot);
  }
  for (const scanRoot of roots) {
    for (const file of walkFiles(path.join(root, scanRoot)))
      candidates.add(relativePath(root, file));
  }
  return candidates;
}

function markerClassification(contract, file, dialect) {
  const exclusion = objects(contract.exclusions).find((candidate) =>
    exclusionMatches(candidate, file, dialect),
  );
  return {
    classification: exclusion?.classification || 'live',
    classificationReason: exclusion?.reason || null,
  };
}

function discoverTextSurfaceMarkers(contract, file, extension, text) {
  const markers = [];
  for (const dialect of objects(contract.dialects)) {
    if (
      dialect.kind === 'structured' ||
      !strings(dialect.extensions).includes(extension) ||
      !strings(dialect.roots).some(
        (scanRoot) => file === scanRoot || file.startsWith(`${scanRoot}/`),
      )
    )
      continue;
    let detected = [];
    if (dialect.kind === 'document') {
      const metadata = frontmatter(text);
      if (metadata?.document_status === 'deprecated') {
        const binding =
          metadata.deprecation_entry && metadata.deprecation_marker
            ? {
                entryId: metadata.deprecation_entry,
                markerId: metadata.deprecation_marker,
              }
            : null;
        detected = [{ offset: 0, raw: 'document_status: deprecated', binding }];
      }
    } else {
      detected = textMarkers(dialect.id, text);
    }
    for (const marker of detected) {
      markers.push({
        dialect: dialect.id,
        path: file,
        line: lineAt(text, marker.offset),
        binding: marker.binding,
        ...markerClassification(contract, file, dialect.id),
      });
    }
  }
  return markers;
}

function discoverStructuredSurfaceMarkers(contract, file, absolute) {
  if (path.extname(file).toLowerCase() !== '.json') return [];
  const markers = [];
  for (const source of objects(contract.structuredSources)) {
    if (!structuredSourceMatches(source, file)) continue;
    const value = jsonPointer(readJson(absolute), String(source.pointer || ''));
    let records = [];
    if (source.mode === 'array-records') {
      records = Array.isArray(value) ? value : [];
    } else if (source.mode === 'optional-record' && value !== undefined) {
      records = [value];
    }
    for (let index = 0; index < records.length; index += 1) {
      markers.push({
        dialect: source.dialect,
        path: file,
        line: null,
        recordIndex: index,
        binding: bindingFromRecord(records[index]),
        ...markerClassification(contract, file, source.dialect),
      });
    }
  }
  return markers;
}

function discoverFileSurfaceMarkers(root, contract, file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || fs.readFileSync(absolute).includes(0))
    return [];
  const extension = path.extname(file).toLowerCase();
  const text = fs.readFileSync(absolute, 'utf8');
  return [
    ...discoverTextSurfaceMarkers(contract, file, extension, text),
    ...discoverStructuredSurfaceMarkers(contract, file, absolute),
  ];
}

/**
 * @param {{root: string, contract: any, changedFiles?: string[]}} options
 */
export function discoverDeprecationSurfaces(options) {
  const root = path.resolve(options.root);
  const contract = options.contract;
  const contractValidation = validateDiscoveryContract(contract);
  const changedFiles = options.changedFiles?.map(normalizePath);
  const scope = changedFiles ? 'changed' : 'full';
  if (!contractValidation.ok) {
    return {
      scope,
      markers: [],
      findings: contractValidation.findings,
      contractRoot: hashJson(contract),
    };
  }
  const candidates = discoveryCandidates(root, contract, changedFiles);
  const markers = [...candidates]
    .sort()
    .flatMap((file) => discoverFileSurfaceMarkers(root, contract, file));
  return {
    scope,
    markers,
    findings: [],
    contractRoot: hashJson(contract),
  };
}
/**
 * @param {{root: string, contract: any, registry: any, changedFiles?: string[]}} options
 */
export function evaluateDeprecationEnrollment(options) {
  const discovery = discoverDeprecationSurfaces(options);
  const findings = [...discovery.findings];
  const live = discovery.markers.filter(
    (marker) => marker.classification === 'live',
  );
  const classified = discovery.markers.filter(
    (marker) => marker.classification !== 'live',
  );
  const entries = new Map(
    objects(options.registry.entries).map((entry) => [entry.id, entry]),
  );
  const declarations = new Map();
  for (const entry of objects(options.registry.entries)) {
    for (const marker of objects(entry.surface?.markers)) {
      const key = `${entry.id}#${marker.id}`;
      if (declarations.has(key)) {
        findings.push({
          code: 'deprecation-duplicate-marker',
          entry: entry.id,
          message: `${key}: registry marker identity is duplicated`,
        });
      } else {
        declarations.set(key, { entry, marker });
      }
    }
  }
  const occurrences = new Map();
  const bindingOccurrences = new Map();
  for (const marker of live) {
    const coordinate = `${marker.path}:${marker.line ?? `record-${marker.recordIndex ?? 0}`}`;
    if (!marker.binding) {
      findings.push({
        code: 'deprecation-orphan-marker',
        entry: null,
        message: `${coordinate}: ${marker.dialect} marker lacks one binding token`,
      });
      continue;
    }
    const key = `${marker.binding.entryId}#${marker.binding.markerId}`;
    const entry = entries.get(marker.binding.entryId);
    if (!entry) {
      findings.push({
        code: 'deprecation-unknown-entry',
        entry: marker.binding.entryId,
        message: `${coordinate}: marker binds unknown entry ${marker.binding.entryId}`,
      });
      continue;
    }
    const declaration = declarations.get(key);
    if (!declaration) {
      findings.push({
        code: 'deprecation-unenrolled-marker',
        entry: marker.binding.entryId,
        message: `${coordinate}: ${key} is not declared by the registry entry`,
      });
      continue;
    }
    const boundRows = bindingOccurrences.get(key) || [];
    boundRows.push(marker);
    bindingOccurrences.set(key, boundRows);
    if (
      declaration.marker.dialect !== marker.dialect ||
      declaration.marker.path !== marker.path
    ) {
      findings.push({
        code: 'deprecation-surface-mismatch',
        entry: marker.binding.entryId,
        message: `${coordinate}: ${key} does not match its declared path and dialect`,
      });
      continue;
    }
    const rows = occurrences.get(key) || [];
    rows.push(marker);
    occurrences.set(key, rows);
  }
  for (const [key, rows] of bindingOccurrences) {
    if (rows.length > 1) {
      findings.push({
        code: 'deprecation-duplicate-marker',
        entry: rows[0].binding.entryId,
        message: `${key}: live marker occurs ${rows.length} times`,
      });
    }
  }

  const entriesWithoutLiveSurface = [];
  if (discovery.scope === 'full') {
    for (const entry of objects(options.registry.entries)) {
      if (!['active', 'deprecated'].includes(entry.lifecycle)) continue;
      const declared = objects(entry.surface?.markers);
      if (declared.length === 0) {
        entriesWithoutLiveSurface.push(entry.id);
        findings.push({
          code: 'deprecation-entry-without-live-surface',
          entry: entry.id,
          message: `${entry.id}: live lifecycle entry declares no surface markers`,
        });
        continue;
      }
      for (const marker of declared) {
        const key = `${entry.id}#${marker.id}`;
        if ((occurrences.get(key) || []).length !== 1) {
          findings.push({
            code: 'deprecation-missing-surface',
            entry: entry.id,
            message: `${key}: declared live surface is missing`,
          });
        }
      }
      if (
        declared.every(
          (marker) =>
            (occurrences.get(`${entry.id}#${marker.id}`) || []).length === 0,
        )
      ) {
        entriesWithoutLiveSurface.push(entry.id);
      }
    }
  }

  const markerProjection = (marker) => ({
    entryId: marker.binding?.entryId || null,
    markerId: marker.binding?.markerId || null,
    dialect: marker.dialect,
    path: marker.path,
    line: marker.line,
  });
  return {
    ok: findings.length === 0,
    findings,
    inventory: {
      schema: options.contract.projectionSchema,
      generatedFrom: 'repository-state',
      readOnly: true,
      scope: discovery.scope,
      roots: {
        discovery: discovery.contractRoot,
        registry: hashJson(options.registry),
      },
      live: live.map(markerProjection),
      settled: objects(options.registry.entries)
        .filter((entry) => ['removed', 'settled'].includes(entry.lifecycle))
        .map((entry) => ({
          entryId: entry.id,
          lifecycle: entry.lifecycle,
          surfaceClass: entry.surfaceClass,
        })),
      classifications: {
        generatedCode: classified
          .filter((marker) => marker.classification === 'generated-code')
          .map(markerProjection),
        historicalEvidence: classified
          .filter((marker) => marker.classification === 'historical-evidence')
          .map(markerProjection),
      },
      diagnostics: {
        entriesWithoutLiveSurface: [
          ...new Set(entriesWithoutLiveSurface),
        ].sort(),
      },
    },
  };
}
