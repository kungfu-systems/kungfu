#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'docs/vocabulary.registry.json';
const LEVELS = new Set(['suggestion', 'warning', 'error']);

/** @typedef {{code: string, file: string, line: number, message: string}} Finding */
/**
 * @typedef {{name: string, caseForms?: string[]}} VocabularyTerm
 * @typedef {{id: string, heading: string, terms: VocabularyTerm[]}} VocabularyLayer
 * @typedef {{text: string, level: string, message: string}} RetiredPhrase
 * @typedef {{pattern: string, replacement: string, level: string}} PreferredTerm
 * @typedef {{pattern: string, level: string, message: string}} ClaimGuard
 * @typedef {{schemaVersion: number, canonicalReference: string, layers: VocabularyLayer[], domainProfiles?: unknown[], prosePolicy: {roots: string[], retiredPhrases: RetiredPhrase[], preferredTerms: PreferredTerm[], claimGuards: ClaimGuard[]}}} VocabularyRegistry
 */

/** @param {string} value */
function yamlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {string} value */
function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} pattern */
function validatePattern(pattern) {
  const inlineCase = pattern.startsWith('(?i)');
  new RegExp(inlineCase ? pattern.slice(4) : pattern, inlineCase ? 'i' : '');
}

/** @param {string} rel */
function safeRelative(rel) {
  return (
    typeof rel === 'string' &&
    rel.length > 0 &&
    !path.isAbsolute(rel) &&
    !rel.split(/[\\/]/).includes('..')
  );
}

/** @param {string} root @param {string} registryPath */
export function readVocabularyRegistry(
  root = ROOT,
  registryPath = DEFAULT_REGISTRY,
) {
  return /** @type {VocabularyRegistry} */ (
    JSON.parse(fs.readFileSync(path.join(root, registryPath), 'utf8'))
  );
}

/** @param {string} text */
function documentedLayers(text) {
  /** @type {{heading: string, terms: string[]}[]} */
  const layers = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^## ([^#].*)$/.exec(line);
    if (section) {
      if (section[1] === 'Domain profiles') break;
      current = { heading: section[1].trim(), terms: [] };
      layers.push(current);
      continue;
    }
    const term = /^### ([^#].*)$/.exec(line);
    if (term && current) current.terms.push(term[1].trim());
  }
  return layers;
}

/** @param {string} root @param {string} rel */
function markdownBelow(root, rel) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile())
    return /\.(?:md|markdown)$/i.test(rel) ? [rel] : [];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => markdownBelow(root, path.posix.join(rel, entry.name)));
}

/** @param {string} root @param {VocabularyRegistry} registry */
export function proseFiles(root, registry) {
  return [
    ...new Set(
      (registry.prosePolicy?.roots || [])
        .filter(safeRelative)
        .flatMap((rel) => markdownBelow(root, rel)),
    ),
  ].sort();
}

/**
 * Validate the executable vocabulary authority and its public projection.
 * @param {{root?: string, registry?: VocabularyRegistry, registryPath?: string}} options
 * @returns {Finding[]}
 */
export function validateVocabularyContract(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const registryPath = options.registryPath || DEFAULT_REGISTRY;
  const registry =
    options.registry || readVocabularyRegistry(root, registryPath);
  /** @type {Finding[]} */
  const findings = [];
  const add = (code, message, file = registryPath) =>
    findings.push({ code, file, line: 1, message });

  if (registry.schemaVersion !== 1) {
    add(
      'vocabulary-schema',
      `unsupported schemaVersion ${String(registry.schemaVersion)}`,
    );
    return findings;
  }
  if (!safeRelative(registry.canonicalReference)) {
    add(
      'vocabulary-schema',
      'canonicalReference must be a repository-relative path',
    );
    return findings;
  }

  if (!Array.isArray(registry.layers) || !registry.layers.length)
    add('vocabulary-schema', 'at least one vocabulary layer is required');
  if (
    !Array.isArray(registry.prosePolicy?.roots) ||
    !registry.prosePolicy.roots.length
  )
    add('vocabulary-schema', 'at least one governed prose root is required');

  const seenLayers = new Set();
  const seenTerms = new Set();
  for (const layer of registry.layers || []) {
    if (!layer.id || !layer.heading || !Array.isArray(layer.terms)) {
      add('vocabulary-schema', 'every layer needs id, heading, and terms');
      continue;
    }
    if (seenLayers.has(layer.id))
      add('vocabulary-duplicate', `duplicate layer id: ${layer.id}`);
    seenLayers.add(layer.id);
    for (const term of layer.terms) {
      if (!term.name) {
        add('vocabulary-schema', `empty term in layer ${layer.id}`);
        continue;
      }
      if (seenTerms.has(term.name))
        add('vocabulary-duplicate', `duplicate canonical term: ${term.name}`);
      seenTerms.add(term.name);
      for (const form of term.caseForms || []) {
        if (!form || /\s/.test(form))
          add(
            'vocabulary-pattern',
            `invalid case-sensitive form for ${term.name}: ${JSON.stringify(form)}`,
          );
      }
    }
  }

  const referencePath = path.join(root, registry.canonicalReference);
  if (!fs.existsSync(referencePath)) {
    add(
      'vocabulary-reference',
      `canonical reference is missing: ${registry.canonicalReference}`,
    );
  } else {
    const actual = documentedLayers(fs.readFileSync(referencePath, 'utf8'));
    const expected = (registry.layers || []).map((layer) => ({
      heading: layer.heading,
      terms: layer.terms.map((term) => term.name),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      findings.push({
        code: 'vocabulary-reference-drift',
        file: registry.canonicalReference,
        line: 1,
        message:
          'layer headings or canonical term headings differ from vocabulary.registry.json',
      });
    }
  }

  for (const rel of registry.prosePolicy?.roots || []) {
    if (!safeRelative(rel)) {
      add(
        'prose-policy-root',
        `governed prose root must stay inside the repository: ${String(rel)}`,
      );
      continue;
    }
    if (!fs.existsSync(path.join(root, rel)))
      add('prose-policy-root', `governed prose root is missing: ${rel}`);
  }
  if (!proseFiles(root, registry).includes(registry.canonicalReference)) {
    add(
      'prose-policy-root',
      'canonicalReference must be included below prosePolicy.roots',
    );
  }

  for (const [kind, rules] of [
    ['retired phrase', registry.prosePolicy?.retiredPhrases || []],
    ['preferred term', registry.prosePolicy?.preferredTerms || []],
    ['claim guard', registry.prosePolicy?.claimGuards || []],
  ]) {
    for (const rule of rules) {
      if (!LEVELS.has(rule.level))
        add('prose-policy-level', `${kind} has invalid level: ${rule.level}`);
      const pattern = 'pattern' in rule ? rule.pattern : regexEscape(rule.text);
      try {
        validatePattern(pattern);
      } catch (error) {
        add(
          'prose-policy-pattern',
          `invalid ${kind} pattern: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return findings.sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * Materialize a disposable Vale projection. The registry remains authoritative.
 * @param {string} destination
 * @param {{root?: string, registry?: VocabularyRegistry, minAlertLevel?: string}} options
 */
export function writeValeProjection(destination, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const registry = options.registry || readVocabularyRegistry(root);
  const minAlertLevel = options.minAlertLevel || 'warning';
  if (!LEVELS.has(minAlertLevel))
    throw new Error(`invalid Vale minimum alert level: ${minAlertLevel}`);
  const findings = validateVocabularyContract({ root, registry });
  if (findings.length) {
    throw new Error(
      `vocabulary contract is invalid: ${findings.map((finding) => finding.code).join(', ')}`,
    );
  }

  const styleRoot = path.join(destination, 'styles');
  const kungfuStyle = path.join(styleRoot, 'Kungfu');
  const vocabRoot = path.join(styleRoot, 'config', 'vocabularies', 'Kungfu');
  fs.mkdirSync(kungfuStyle, { recursive: true });
  fs.mkdirSync(vocabRoot, { recursive: true });

  fs.writeFileSync(
    path.join(destination, '.vale.ini'),
    [
      '# Generated from docs/vocabulary.registry.json; do not edit.',
      'StylesPath = styles',
      `MinAlertLevel = ${minAlertLevel}`,
      'Vocab = Kungfu',
      '',
      '[*.md]',
      'BasedOnStyles = Vale, Kungfu',
      'Vale.Spelling = NO',
      'Vale.Repetition = NO',
      '',
    ].join('\n'),
  );

  const casePatterns = registry.layers
    .flatMap((layer) => layer.terms)
    .flatMap((term) => term.caseForms || []);
  fs.writeFileSync(
    path.join(vocabRoot, 'accept.txt'),
    `${casePatterns.join('\n')}\n`,
  );
  fs.writeFileSync(path.join(vocabRoot, 'reject.txt'), '');

  registry.prosePolicy.retiredPhrases.forEach((rule, index) => {
    fs.writeFileSync(
      path.join(kungfuStyle, `RetiredPhrase${index + 1}.yml`),
      [
        '# Generated from docs/vocabulary.registry.json; do not edit.',
        'extends: existence',
        `message: ${yamlString(rule.message)}`,
        `level: ${rule.level}`,
        'ignorecase: true',
        'tokens:',
        `  - ${yamlString(regexEscape(rule.text))}`,
        '',
      ].join('\n'),
    );
  });

  registry.prosePolicy.preferredTerms.forEach((rule, index) => {
    fs.writeFileSync(
      path.join(kungfuStyle, `PreferredTerm${index + 1}.yml`),
      [
        '# Generated from docs/vocabulary.registry.json; do not edit.',
        'extends: substitution',
        `message: ${yamlString("Use '%s' instead of '%s'.")}`,
        `level: ${rule.level}`,
        'swap:',
        `  ${yamlString(rule.pattern)}: ${yamlString(rule.replacement)}`,
        '',
      ].join('\n'),
    );
  });

  registry.prosePolicy.claimGuards.forEach((rule, index) => {
    fs.writeFileSync(
      path.join(kungfuStyle, `ClaimGuard${index + 1}.yml`),
      [
        '# Generated from docs/vocabulary.registry.json; do not edit.',
        'extends: existence',
        `message: ${yamlString(rule.message)}`,
        `level: ${rule.level}`,
        'tokens:',
        `  - ${yamlString(rule.pattern)}`,
        '',
      ].join('\n'),
    );
  });

  return {
    config: path.join(destination, '.vale.ini'),
    files: proseFiles(root, registry),
  };
}
