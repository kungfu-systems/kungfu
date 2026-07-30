#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyAdrIdentity } from './adr-identity.mjs';
import { markdownFiles } from './check-docs.mjs';
import { buildHumanSurfaceInventory } from './shifu-documentation-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = process.env.KUNGFU_DOCS_MODULES;
const requireFrom = createRequire(
  MODULES
    ? path.join(path.resolve(MODULES), '..', 'package.json')
    : import.meta.url,
);
const MarkdownIt = (
  await import(pathToFileURL(requireFrom.resolve('markdown-it')).href)
).default;
const MARKDOWN = new MarkdownIt({ html: true, linkify: false });
const UUID_V7 =
  '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ADR_REFERENCE = new RegExp(
  `(?<![A-Z0-9-])(?:KF|SHIFU)-ADR-${UUID_V7}(?![0-9a-f-])`,
  'g',
);
const ADR_LIKE =
  /(?<![A-Z0-9-])(?:KF|SHIFU)-ADR-[A-Za-z0-9][A-Za-z0-9-]*(?![A-Za-z0-9-])/g;
const ADR_FILE = new RegExp(`^((?:KF|SHIFU)-ADR-${UUID_V7})\\.md$`);
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** @typedef {{code: string, file: string, line: number, message: string}} Finding */

/** @param {string} text @param {RegExp} pattern */
function matches(text, pattern) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)];
}

/** @param {string} root */
function adrTargets(root) {
  const directory = path.join(root, 'docs', 'adr');
  const targets = new Map();
  if (!fs.existsSync(directory)) return targets;
  for (const name of fs.readdirSync(directory).sort()) {
    const match = ADR_FILE.exec(name);
    if (match) targets.set(match[1], path.posix.join('docs', 'adr', name));
  }
  return targets;
}

/** @param {string} sourceRel @param {string} href */
function linkedTarget(sourceRel, href) {
  const trimmed = href.trim().replace(/^<|>$/g, '');
  if (!trimmed || trimmed.startsWith('//') || EXTERNAL_SCHEME.test(trimmed)) {
    return null;
  }
  const withoutFragment = trimmed.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return sourceRel;
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(sourceRel), withoutFragment),
  );
}

/** @param {string} text @param {number} index */
function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

/** @param {string} value @param {number} index */
function occurrenceIsBareUrl(value, index) {
  const start = Math.max(
    value.lastIndexOf(' ', index),
    value.lastIndexOf('\n', index),
    value.lastIndexOf('\t', index),
  );
  const endCandidates = [
    value.indexOf(' ', index),
    value.indexOf('\n', index),
    value.indexOf('\t', index),
  ].filter((candidate) => candidate >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : value.length;
  return /^(?:https?|file):\/\//i.test(value.slice(start + 1, end));
}

/** @param {string} text */
function frontmatterEndLine(text) {
  if (!/^---\r?\n/.test(text)) return 0;
  const lines = text.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1)
    if (lines[index] === '---' || lines[index] === '...') return index + 1;
  return 0;
}

/** @param {number} depth @param {string} html */
function updateHtmlDepth(depth, html) {
  const closing = /^<\s*\/\s*([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/.exec(html);
  if (closing) return Math.max(0, depth - 1);
  const opening = /^<\s*([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/.exec(html);
  if (!opening) return depth;
  const name = opening[1].toLowerCase();
  const selfClosing = /\/\s*>\s*$/.test(html);
  return selfClosing || HTML_VOID_ELEMENTS.has(name) ? depth : depth + 1;
}

/**
 * @param {{
 *   root?: string,
 *   files?: string[],
 *   lifecycles?: Map<string, string> | Record<string, string>
 * }} options
 * @returns {Finding[]}
 */
export function checkAdrReferenceLinks(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const files = options.files || markdownFiles(root);
  const lifecycleFor =
    options.lifecycles instanceof Map
      ? options.lifecycles
      : new Map(Object.entries(options.lifecycles || {}));
  const targets = adrTargets(root);
  /** @type {Finding[]} */
  const findings = [];

  for (const rel of files) {
    if (lifecycleFor.get(rel) !== 'authored') continue;
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const tokens = MARKDOWN.parse(text, {});
    const frontmatterLines = frontmatterEndLine(text);

    for (const token of tokens) {
      if (token.type !== 'inline') continue;
      if ((token.map?.[0] ?? 0) < frontmatterLines) continue;
      let linkHref = '';
      let htmlDepth = 0;
      for (const child of token.children || []) {
        if (child.type === 'link_open') {
          linkHref = child.attrGet('href') || '';
          continue;
        }
        if (child.type === 'link_close') {
          linkHref = '';
          continue;
        }
        if (child.type === 'html_inline') {
          htmlDepth = updateHtmlDepth(htmlDepth, child.content);
          continue;
        }
        if (child.type !== 'text') continue;
        if (htmlDepth > 0) continue;

        for (const match of matches(child.content, ADR_LIKE)) {
          if (classifyAdrIdentity(match[0])) continue;
          const linked = linkHref ? linkedTarget(rel, linkHref) : null;
          const linkedId = linked ? path.posix.basename(linked, '.md') : '';
          // A linked leading prefix is an intentional human navigation key,
          // not a second ADR identity. Complete-looking drift still fails.
          if (linkedId.startsWith(match[0])) continue;
          findings.push({
            code: 'malformed-adr-reference',
            file: rel,
            line: (token.map?.[0] ?? 0) + lineAt(child.content, match.index),
            message: `ADR identity is not a canonical owner-prefixed UUIDv7: ${match[0]}`,
          });
        }

        for (const match of matches(child.content, ADR_REFERENCE)) {
          const id = match[0];
          if (occurrenceIsBareUrl(child.content, match.index)) continue;
          const expected = targets.get(id);
          const line =
            (token.map?.[0] ?? 0) + lineAt(child.content, match.index);
          if (!expected) {
            findings.push({
              code: 'missing-adr-target',
              file: rel,
              line,
              message: `ADR reference has no canonical target: ${id}`,
            });
            continue;
          }
          if (!linkHref) {
            findings.push({
              code: 'unlinked-adr-reference',
              file: rel,
              line,
              message: `${id} must link to ${expected}`,
            });
            continue;
          }
          if (linkedTarget(rel, linkHref) !== expected) {
            findings.push({
              code: 'adr-reference-target-mismatch',
              file: rel,
              line,
              message: `${id} must link to ${expected}, not ${linkHref}`,
            });
          }
        }
      }
    }
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
}

function lifecycleMap(root, files) {
  const inventory = buildHumanSurfaceInventory({ root, files });
  return new Map(
    inventory.entries
      .filter((entry) => entry.kind === 'document-file')
      .map((entry) => [entry.path, entry.lifecycle]),
  );
}

function main() {
  const files = markdownFiles(ROOT);
  const lifecycles = lifecycleMap(ROOT, files);
  const findings = checkAdrReferenceLinks({ root: ROOT, files, lifecycles });
  if (!findings.length) {
    console.log(
      `[adr-links] checked ${files.length} Markdown files; authored ADR references are linked and resolvable`,
    );
    return;
  }
  console.error('[adr-links] ADR reference violations:');
  for (const finding of findings)
    console.error(
      `  ${finding.file}:${finding.line} [${finding.code}] ${finding.message}`,
    );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
