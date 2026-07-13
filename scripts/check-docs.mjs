#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseFrontmatter,
  validateDocumentMetadata,
} from './document-metadata-contract.mjs';
import { validateVocabularyContract } from './vocabulary-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = process.env.KUNGFU_DOCS_MODULES;
const requireFrom = createRequire(
  MODULES
    ? path.join(path.resolve(MODULES), '..', 'package.json')
    : import.meta.url,
);
const GithubSlugger = (
  await import(pathToFileURL(requireFrom.resolve('github-slugger')).href)
).default;
const MarkdownIt = (
  await import(pathToFileURL(requireFrom.resolve('markdown-it')).href)
).default;
const DEFAULT_CONTRACT = 'docs.contract.json';
const MARKDOWN = new MarkdownIt({ html: true, linkify: false });
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_EXAMPLE_COMMANDS = new Set([
  JSON.stringify(['./shifu', 'self-version']),
  JSON.stringify(['./shifu', '--version']),
]);

/** @typedef {{code: string, file: string, line: number, message: string}} Finding */
/** @typedef {{href: string, line: number}} Link */
/** @typedef {{id: string, line: number, source: string}} ExecutableExample */
/** @typedef {{rel: string, text: string, anchors: Set<string>, links: Link[], examples: ExecutableExample[]}} Document */
/**
 * @typedef {{
 *   schemaVersion: number,
 *   requiredFiles?: string[],
 *   requiredPointers?: {from: string, to: string}[],
 *   hierarchy?: {root: string, entryFiles: string[], canonicalDirectories: string[]},
 *   publication?: {roots: string[], include: string[], allowedOrphans?: string[], allowedOrphanDocumentTypes?: string[]},
 *   executableExamples?: {id: string, file: string, command: string[], stdoutPattern?: string, timeoutMs?: number}[]
 * }} DocsContract
 */

/** @param {string} value */
function posix(value) {
  return value.split(path.sep).join('/');
}

/** @param {string} value */
function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** @param {import('markdown-it/lib/token.mjs').default[]} children */
function headingText(children = []) {
  return children
    .filter((token) =>
      ['text', 'code_inline', 'emoji', 'image'].includes(token.type),
    )
    .map((token) => token.content)
    .join('');
}

/** @param {string} text @param {number} index */
function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

/** @param {string} root */
export function markdownFiles(root = ROOT) {
  const result = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '*.md',
      '*.markdown',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !rel.startsWith('framework/core/.deps/'))
    .filter((rel) => !rel.split('/').includes('node_modules'))
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .sort();
}

/** @param {string} rel @param {string} text */
export function parseDocument(rel, text) {
  const tokens = MARKDOWN.parse(text, {});
  const anchors = new Set();
  const links = [];
  const examples = [];
  const slugger = new GithubSlugger();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1];
      anchors.add(slugger.slug(headingText(inline?.children || [])));
    }
    if (token.type === 'fence') {
      const match = /(?:^|\s)docs-exec=([a-z0-9][a-z0-9-]*)\b/.exec(token.info);
      if (match)
        examples.push({
          id: match[1],
          line: (token.map?.[0] ?? 0) + 1,
          source: token.content.trim(),
        });
    }
    if (token.type !== 'inline') continue;
    const line = (token.map?.[0] ?? 0) + 1;
    for (const child of token.children || []) {
      if (child.type === 'link_open') {
        const href = child.attrGet('href');
        if (href) links.push({ href, line });
      } else if (child.type === 'image') {
        const href = child.attrGet('src');
        if (href) links.push({ href, line });
      }
    }
  }

  const anchorPattern =
    /<(?:a|span)\b[^>]*(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(anchorPattern))
    anchors.add(decode(match[1]));

  const htmlLinkPattern =
    /<(?:a|img)\b[^>]*(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(htmlLinkPattern)) {
    links.push({ href: match[1], line: lineAt(text, match.index || 0) });
  }

  return { rel, text, anchors, links, examples };
}

/** @param {string} root @param {string} contractPath */
export function readContract(root = ROOT, contractPath = DEFAULT_CONTRACT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, contractPath), 'utf8'),
  );
  if (contract.schemaVersion !== 2) {
    throw new Error(
      `${contractPath}: unsupported schemaVersion ${String(contract.schemaVersion)}`,
    );
  }
  return /** @type {DocsContract} */ (contract);
}

/** @param {string} root @param {string} sourceRel @param {string} href */
function resolveLocal(root, sourceRel, href) {
  const trimmed = href.trim().replace(/^<|>$/g, '');
  if (!trimmed || trimmed.startsWith('//') || EXTERNAL_SCHEME.test(trimmed)) {
    return null;
  }
  const hashAt = trimmed.indexOf('#');
  const withoutFragment = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed;
  const fragment = hashAt >= 0 ? decode(trimmed.slice(hashAt + 1)) : '';
  const queryAt = withoutFragment.indexOf('?');
  const pathname = decode(
    queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment,
  );
  const target = pathname
    ? path.resolve(
        pathname.startsWith('/')
          ? root
          : path.dirname(path.join(root, sourceRel)),
        pathname.startsWith('/') ? `.${pathname}` : pathname,
      )
    : path.join(root, sourceRel);
  return { target, fragment };
}

/** @param {string} root @param {string} absolute */
function relativeInside(root, absolute) {
  const rel = path.relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return posix(rel);
}

/** @param {string} root @param {string} absolute */
function hasExactCase(root, absolute) {
  const rel = relativeInside(root, absolute);
  if (rel === null) return false;
  let current = root;
  for (const segment of rel.split('/').filter(Boolean)) {
    if (!fs.readdirSync(current).includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

/**
 * @param {{root?: string, files?: string[], contract?: DocsContract, vocabularyRegistry?: object | false, metadataContract?: object | false}} options
 * @returns {Finding[]}
 */
export function checkDocs(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const files = options.files || markdownFiles(root);
  const contract = options.contract || readContract(root);
  /** @type {Map<string, Document>} */
  const documents = new Map();
  /** @type {Finding[]} */
  const findings =
    options.vocabularyRegistry === false
      ? []
      : validateVocabularyContract({
          root,
          registry: /** @type {any} */ (options.vocabularyRegistry),
        });

  if (options.metadataContract !== false) {
    findings.push(
      ...validateDocumentMetadata({
        root,
        files,
        contract: /** @type {any} */ (options.metadataContract),
      }),
    );
  }

  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    documents.set(rel, parseDocument(rel, text));
  }

  const hierarchy = contract.hierarchy;
  if (hierarchy) {
    const hierarchyRoot = hierarchy.root.replace(/\/$/, '');
    const entries = new Set(hierarchy.entryFiles || []);
    const canonicalDirectories = hierarchy.canonicalDirectories || [];
    for (const rel of files.filter(
      (file) => file.startsWith(`${hierarchyRoot}/`) || file === hierarchyRoot,
    )) {
      if (path.posix.dirname(rel) === hierarchyRoot) {
        if (!entries.has(rel)) {
          findings.push({
            code: 'documentation-hierarchy-root',
            file: rel,
            line: 1,
            message: 'root Markdown must be a declared entry file',
          });
        }
        continue;
      }
      if (
        !canonicalDirectories.some(
          (directory) => rel === directory || rel.startsWith(`${directory}/`),
        )
      ) {
        findings.push({
          code: 'documentation-hierarchy-directory',
          file: rel,
          line: 1,
          message:
            'canonical documentation is outside the declared directory taxonomy',
        });
      }
    }
  }

  for (const rel of contract.requiredFiles || []) {
    if (!fs.existsSync(path.join(root, rel))) {
      findings.push({
        code: 'required-file',
        file: rel,
        line: 1,
        message: 'required documentation surface is missing',
      });
    }
  }

  for (const document of documents.values()) {
    for (const link of document.links) {
      const local = resolveLocal(root, document.rel, link.href);
      if (!local) continue;
      const targetRel = relativeInside(root, local.target);
      if (!targetRel) {
        findings.push({
          code: 'outside-root',
          file: document.rel,
          line: link.line,
          message: `local link escapes the repository: ${link.href}`,
        });
        continue;
      }
      if (!fs.existsSync(local.target)) {
        findings.push({
          code: 'missing-target',
          file: document.rel,
          line: link.line,
          message: `local link target does not exist: ${link.href}`,
        });
        continue;
      }
      if (!hasExactCase(root, local.target)) {
        findings.push({
          code: 'case-mismatch',
          file: document.rel,
          line: link.line,
          message: `local link path casing does not match the repository: ${link.href}`,
        });
        continue;
      }
      if (!local.fragment || !/\.(?:md|markdown)$/i.test(targetRel)) continue;
      let target = documents.get(targetRel);
      if (!target) {
        target = parseDocument(
          targetRel,
          fs.readFileSync(local.target, 'utf8'),
        );
        documents.set(targetRel, target);
      }
      if (!target.anchors.has(local.fragment)) {
        findings.push({
          code: 'missing-anchor',
          file: document.rel,
          line: link.line,
          message: `Markdown anchor does not exist: ${link.href}`,
        });
      }
    }
  }

  for (const pointer of contract.requiredPointers || []) {
    const source = documents.get(pointer.from);
    if (!source) continue;
    const found = source.links.some((link) => {
      const local = resolveLocal(root, pointer.from, link.href);
      return local && relativeInside(root, local.target) === pointer.to;
    });
    if (!found) {
      findings.push({
        code: 'required-pointer',
        file: pointer.from,
        line: 1,
        message: `required documentation pointer is missing: ${pointer.to}`,
      });
    }
  }

  const declaredExamples = new Map(
    (contract.executableExamples || []).map((example) => [example.id, example]),
  );
  const observedExamples = new Map();
  for (const document of documents.values()) {
    for (const example of document.examples) {
      if (observedExamples.has(example.id)) {
        findings.push({
          code: 'executable-example-duplicate',
          file: document.rel,
          line: example.line,
          message: `duplicate executable example id: ${example.id}`,
        });
        continue;
      }
      observedExamples.set(example.id, { ...example, file: document.rel });
      const declaration = declaredExamples.get(example.id);
      if (!declaration) {
        findings.push({
          code: 'executable-example-undeclared',
          file: document.rel,
          line: example.line,
          message: `executable example is not declared in ${DEFAULT_CONTRACT}: ${example.id}`,
        });
      } else if (
        declaration.file !== document.rel ||
        declaration.command.join(' ') !== example.source
      ) {
        findings.push({
          code: 'executable-example-drift',
          file: document.rel,
          line: example.line,
          message: `executable example differs from its safe command contract: ${example.id}`,
        });
      }
    }
  }
  for (const declaration of declaredExamples.values()) {
    if (!observedExamples.has(declaration.id))
      findings.push({
        code: 'executable-example-missing',
        file: declaration.file,
        line: 1,
        message: `declared executable example is missing: ${declaration.id}`,
      });
    if (
      !Array.isArray(declaration.command) ||
      !declaration.command.length ||
      !Number.isInteger(declaration.timeoutMs) ||
      declaration.timeoutMs < 100 ||
      declaration.timeoutMs > 30000
    )
      findings.push({
        code: 'executable-example-contract',
        file: DEFAULT_CONTRACT,
        line: 1,
        message: `invalid bounded command contract: ${declaration.id}`,
      });
    else if (!SAFE_EXAMPLE_COMMANDS.has(JSON.stringify(declaration.command)))
      findings.push({
        code: 'executable-example-unsafe',
        file: DEFAULT_CONTRACT,
        line: 1,
        message: `command is not in the side-effect-free documentation allowlist: ${declaration.id}`,
      });
    if (declaration.stdoutPattern) {
      try {
        new RegExp(declaration.stdoutPattern);
      } catch {
        findings.push({
          code: 'executable-example-contract',
          file: DEFAULT_CONTRACT,
          line: 1,
          message: `invalid stdoutPattern: ${declaration.id}`,
        });
      }
    }
  }

  const publication = contract.publication;
  if (publication) {
    const included = new Set(
      files.filter((rel) =>
        publication.include.some(
          (entry) => rel === entry || rel.startsWith(`${entry}/`),
        ),
      ),
    );
    const allowed = new Set(publication.allowedOrphans || []);
    const allowedTypes = new Set(publication.allowedOrphanDocumentTypes || []);
    const reachable = new Set(
      publication.roots.filter((rel) => included.has(rel)),
    );
    const queue = [...reachable];
    while (queue.length) {
      const sourceRel = queue.shift();
      const source = documents.get(sourceRel);
      for (const link of source?.links || []) {
        const local = resolveLocal(root, sourceRel, link.href);
        if (!local) continue;
        const targetRel = relativeInside(root, local.target);
        if (targetRel && included.has(targetRel) && !reachable.has(targetRel)) {
          reachable.add(targetRel);
          queue.push(targetRel);
        }
      }
    }
    for (const rel of included) {
      const frontmatter = parseFrontmatter(documents.get(rel)?.text || '');
      const documentType = String(
        frontmatter?.fields.get('doc_type')?.value || '',
      );
      if (
        !reachable.has(rel) &&
        !allowed.has(rel) &&
        !allowedTypes.has(documentType)
      )
        findings.push({
          code: 'publication-orphan',
          file: rel,
          line: 1,
          message: 'public document is unreachable from every publication root',
        });
    }
    for (const rel of allowed) {
      if (!included.has(rel) || reachable.has(rel))
        findings.push({
          code: 'publication-orphan-exception',
          file: DEFAULT_CONTRACT,
          line: 1,
          message: `stale or invalid allowed orphan: ${rel}`,
        });
    }
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}

function main() {
  const files = markdownFiles(ROOT);
  const findings = checkDocs({ root: ROOT, files });
  if (!findings.length) {
    console.log(
      `[docs] checked ${files.length} Markdown files; local links, anchors, and documentation contracts passed`,
    );
    return;
  }
  console.error('[docs] documentation gate violations:');
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line} [${finding.code}] ${finding.message}`,
    );
  }
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
