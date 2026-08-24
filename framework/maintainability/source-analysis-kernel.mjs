// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DEFAULT_GIT_TIMEOUT_MS = Number(
  process.env.KUNGFU_GIT_COMMAND_TIMEOUT_MS || 30_000,
);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CACHE_SCHEMA = 'kungfu.source-analysis-cache/v1';
const DECISION_TOKENS = {
  python: /\b(?:if|elif|for|while|except|case|and|or)\b/gu,
  rust: /\b(?:if|for|while|match)\b|&&|\|\||=>/gu,
  'c-cpp': /\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/gu,
  'javascript-typescript':
    /\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/gu,
};
const BRACED_FUNCTION_PATTERNS = {
  'javascript-typescript': [
    /\b(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\([^\n)]*\)[ \t]*\{/gu,
    /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\([^\n)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>[ \t]*\{/gu,
    /(?:^|\n)[ \t]*(?:async[ \t]+)?(?:static[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^;{}\n]*\)[ \t]*(?::[ \t]*[^={\n]+)?\{/gu,
  ],
  rust: [
    /\bfn[ \t]+([A-Za-z_]\w*)[ \t]*(?:<[^>{}\n]*>)?[ \t]*\([^\n)]*\)[^{;\n]*\{/gu,
  ],
  'c-cpp': [
    /(?:^|\n)[ \t]*(?:template[ \t]*<[^;{}\n]*>[ \t]*)?(?:[\w:&*<>~,\[\]][\w:&*<>~,\[\] \t]*[ \t]+)?([~A-Za-z_]\w*(?:::\w+)*)[ \t]*\([^;{}\n]*\)[ \t]*(?:const[ \t]*)?(?:noexcept[ \t]*)?(?:->[ \t]*[^{}\n]+)?\{/gu,
  ],
};
const EXCLUDED_BRACED_SYMBOLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'sizeof',
]);
const RETAINED_EVIDENCE_PATTERNS = [
  'docs/qualification/evidence/',
  '/evidence/',
  '/qualification/reports/',
  '/retained/',
];
const VENDORED_SOURCE_PATTERNS = [
  'framework/core/.deps/',
  '/node_modules/',
  '/third_party/',
  '/third-party/',
  '/vendor/',
  '/vendored/',
];
const DECLARATIVE_EXTENSIONS = new Set([
  '.cmake',
  '.fbs',
  '.gyp',
  '.gypi',
  '.json',
  '.jsonc',
  '.lock',
  '.proto',
  '.toml',
  '.yaml',
  '.yml',
]);
const PUBLIC_HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx']);
const PUBLIC_ENTRYPOINTS = new Set(['shifu', 'shifu.cmd']);
const IMPLEMENTATION_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cjs',
  '.cmd',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.js',
  '.mjs',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
]);
const SEGMENT_OWNER_PREFIXES = new Map([
  ['framework', 'framework'],
  ['crates', 'crate'],
  ['developer', 'developer'],
]);
const TOP_LEVEL_OWNERS = new Map([
  ['product', 'product/assembly'],
  ['scripts', 'shifu/source-tooling'],
  ['shifu', 'shifu/source-tooling'],
  ['shifu.cmd', 'shifu/source-tooling'],
  ['docs', 'kungfu/docs'],
  ['.github', 'kungfu/release-workflow'],
  ['config', 'kungfu/config'],
  ['tests', 'kungfu/qualification'],
  ['examples', 'kungfu/examples'],
  ['types', 'kungfu/public-types'],
  ['.kungfu', 'kungfu/retained-native-evidence'],
]);
const REPOSITORY_CONTRACT_TOP_LEVEL = new Set([
  '.buildchain',
  '.xinfa',
  'package.json',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Cargo.toml',
]);
const CORE_BUILD_FILES = new Set([
  'framework/core/conanfile.py',
  'framework/core/CMakeLists.txt',
]);
const CORE_PREFIX_OWNERS = [
  ['framework/core/architecture/', 'core/architecture'],
  ['framework/core/tests/', 'core/qualification'],
  ['framework/core/.gyp/', 'core/build'],
  ['framework/core/lib/', 'core/bindings'],
];
const COMMENT_STATES = {
  '/': 'line-comment',
  '*': 'block-comment',
};
const LINE_COMMENT_TRANSITIONS = {
  true: ['\n', 'code'],
  false: [' ', 'line-comment'],
};
const STRING_QUOTES = {
  python: `"'`,
  rust: `"'`,
  'c-cpp': `"'`,
  'javascript-typescript': `"'\``,
};
const BLANK_EXCEPT_NEWLINE = {
  true: '\n',
  false: ' ',
};
const NO_DECLARED_OWNER = Symbol('no-declared-owner');

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(ordered(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function lineCount(bytes) {
  if (!bytes.length) return 0;
  let count = 1;
  for (const byte of bytes) if (byte === 10) count += 1;
  return bytes[bytes.length - 1] === 10 ? count - 1 : count;
}

function readJson(relative, root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function gitResult(args, options = {}, runner = spawnSync) {
  const root = options.root || ROOT;
  const timeoutMs = Object.hasOwn(options, 'timeoutMs')
    ? options.timeoutMs
    : DEFAULT_GIT_TIMEOUT_MS;
  const result = runner('git', args, {
    cwd: root,
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer || 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ETIMEDOUT')
    throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
  return result;
}

function git(args, options = {}, runner = spawnSync) {
  const result = gitResult(args, options, runner);
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  return result.stdout;
}

function gitLines(args, options = {}) {
  return String(git(args, options))
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function baselineChangedPaths(ref, readLines = gitLines) {
  return new Set(
    readLines(['diff', '--no-renames', '--name-only', ref, 'HEAD', '--'])
      .concat(readLines(['diff', '--no-renames', '--name-only', 'HEAD', '--']))
      .concat(readLines(['ls-files', '--others', '--exclude-standard'])),
  );
}

function currentBytes(relative, root = ROOT) {
  return fs.readFileSync(path.join(root, relative));
}

function baselineBytes(ref, relative, changed = null) {
  const absolute = path.join(ROOT, relative);
  if (changed && !changed.has(relative) && fs.existsSync(absolute))
    return fs.readFileSync(absolute);
  return Buffer.from(git(['show', `${ref}:${relative}`], { binary: true }));
}

function language(pathname) {
  const extension = path.posix.extname(pathname).toLowerCase();
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(
      extension,
    )
  )
    return 'c-cpp';
  if (extension === '.py') return 'python';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(extension))
    return 'javascript-typescript';
  if (extension === '.rs') return 'rust';
  if (['.sh', '.cmd', '.ps1'].includes(extension) || pathname === 'shifu')
    return 'shell';
  if (
    ['.cmake', '.gyp', '.gypi'].includes(extension) ||
    path.posix.basename(pathname) === 'CMakeLists.txt'
  )
    return 'build-declaration';
  return 'declarative';
}

function languageFamily(pathname) {
  const value = language(pathname);
  return ['c-cpp', 'javascript-typescript', 'python', 'rust'].includes(value)
    ? value
    : '';
}

function isEligible(pathname, policy) {
  if (
    pathname === '.kungfu/qualification' ||
    pathname.startsWith('.kungfu/qualification/')
  )
    return false;
  const metadataPaths = [policy.baselinePath];
  const metadataPrefixes = [
    policy.waiverDirectory,
    policy.baselineGovernance?.transitionDirectory,
  ].filter(Boolean);
  if (
    metadataPaths.includes(pathname) ||
    metadataPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  )
    return false;
  return (
    policy.specialEligibleNames.includes(path.posix.basename(pathname)) ||
    policy.eligibleExtensions.includes(
      path.posix.extname(pathname).toLowerCase(),
    )
  );
}

function matchesAny(pathname, patterns) {
  return patterns.some((pattern) => pathname.includes(pattern));
}

function generatedMarker(bytes) {
  return bytes
    .subarray(0, 2048)
    .toString('utf8')
    .split('\n')
    .slice(0, 24)
    .find((line) =>
      /^\s*(?:\/\/|#|\/\*|\*)\s*(?:@generated|generated file|auto-generated|automatically generated|do not edit)\b/iu.test(
        line,
      ),
    );
}

function classify(pathname, bytes) {
  const basename = path.posix.basename(pathname);
  const extension = path.posix.extname(pathname).toLowerCase();
  if (
    pathname.startsWith('.kungfu/') ||
    matchesAny(pathname, RETAINED_EVIDENCE_PATTERNS)
  )
    return 'retained-evidence';
  if (matchesAny(pathname, VENDORED_SOURCE_PATTERNS)) return 'vendored-source';
  if (
    /(?:^|[/_.-])generated(?:[/_.-]|$)/u.test(pathname) ||
    generatedMarker(bytes)
  )
    return 'generated-projection';
  if (
    /(?:^|\/)(?:test|tests|fixtures?|__tests__)(?:\/|$)/u.test(pathname) ||
    /(?:^|[._-])(?:test|spec)(?:[._-]|$)|^test_/u.test(basename)
  )
    return 'test-or-fixture';
  if (
    [
      DECLARATIVE_EXTENSIONS.has(extension),
      basename === 'CMakeLists.txt',
    ].includes(true)
  )
    return 'declarative-schema-or-table';
  const publicHeader =
    pathname.includes('/include/') && PUBLIC_HEADER_EXTENSIONS.has(extension);
  const conventionalEntrypoint =
    /(?:^|\/)(?:main|index|__init__)\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|cjs|ts|tsx|py|rs)$/u.test(
      pathname,
    );
  if (
    [
      publicHeader,
      conventionalEntrypoint,
      PUBLIC_ENTRYPOINTS.has(pathname),
    ].includes(true)
  )
    return 'public-header-or-entrypoint';
  if (IMPLEMENTATION_EXTENSIONS.has(extension))
    return 'first-party-handwritten-implementation';
  return '';
}

function hasGeneratedProvenance(pathname, bytes) {
  const marker = generatedMarker(bytes);
  return Boolean(
    marker &&
      /(?:generated by|generator|source(?:_path)?)[\s:=]+[^\s]+/iu.test(marker),
  );
}

function owns(rule, file) {
  const included =
    (rule.include_files || []).includes(file) ||
    (rule.include_prefixes || []).some((prefix) => file.startsWith(prefix));
  return (
    included &&
    !(rule.exclude_files || []).includes(file) &&
    !(rule.exclude_prefixes || []).some((prefix) => file.startsWith(prefix))
  );
}

function ownerFor(pathname, layers, ownership = []) {
  const declared = ownership.filter((rule) =>
    (rule.paths || []).includes(pathname),
  );
  const declaredOwner = [NO_DECLARED_OWNER, declared[0]?.owner, ''][
    Math.min(declared.length, 2)
  ];
  if (declaredOwner !== NO_DECLARED_OWNER) return declaredOwner;
  const corePrefix = 'framework/core/';
  const corePath = pathname.startsWith(corePrefix);
  const relative = pathname.slice(corePrefix.length);
  const owners = layers.components.filter(
    (component) => corePath && owns(component, relative),
  );
  if (owners.length === 1) return owners[0].owner;
  if (CORE_BUILD_FILES.has(pathname)) return 'core/build';
  const corePrefixOwner = CORE_PREFIX_OWNERS.find(([prefix]) =>
    pathname.startsWith(prefix),
  )?.[1];
  if (corePrefixOwner) return corePrefixOwner;
  if (owners.length > 1) return '';
  if (corePath) return 'core/package';
  const segments = pathname.split('/');
  const top = segments[0];
  const segmentOwner = /^([^/]+)\/([^/]+)/u.exec(pathname);
  const segmentOwnerPrefix = SEGMENT_OWNER_PREFIXES.get(segmentOwner?.[1]);
  if (segmentOwnerPrefix) return `${segmentOwnerPrefix}/${segmentOwner[2]}`;
  if (top === 'extensions' && segments[1])
    return `extension/${segments.slice(1, Math.max(2, Math.min(3, segments.length - 1))).join('/')}`;
  const topLevelOwner = TOP_LEVEL_OWNERS.get(top);
  if (topLevelOwner) return topLevelOwner;
  if (REPOSITORY_CONTRACT_TOP_LEVEL.has(top))
    return 'kungfu/repository-contract';
  if (!pathname.includes('/')) return 'kungfu/repository-contract';
  return '';
}

function trackedCurrentFiles() {
  return String(git(['ls-files', '-z']))
    .split('\0')
    .filter((pathname) => pathname && languageFamily(pathname))
    .map((pathname) => ({
      path: pathname,
      bytes: fs.readFileSync(path.join(ROOT, pathname)),
    }));
}

function trackedFilesAt(ref) {
  const entries = String(
    git(['ls-tree', '-r', '-z', '--format=%(objectname)%x09%(path)', ref]),
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { oid: entry.slice(0, tab), path: entry.slice(tab + 1) };
    })
    .filter(({ path: pathname }) => languageFamily(pathname));
  if (!entries.length) return [];
  const output = git(['cat-file', '--batch'], {
    binary: true,
    input: Buffer.from(`${entries.map(({ oid }) => oid).join('\n')}\n`),
  });
  let offset = 0;
  return entries.map(({ path: pathname }) => {
    const headerEnd = output.indexOf(10, offset);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isInteger(size))
      throw new Error(`invalid Git object for ${pathname}`);
    const start = headerEnd + 1;
    const bytes = Buffer.from(output.subarray(start, start + size));
    offset = start + size + 1;
    return { path: pathname, bytes };
  });
}

function stripStringsAndComments(source, family) {
  const chars = [...source];
  const stringQuotes = STRING_QUOTES[family] || STRING_QUOTES.rust;
  let state = 'code';
  let quote = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1] || '';
    if (state === 'line-comment') {
      [chars[index], state] = LINE_COMMENT_TRANSITIONS[char === '\n'];
      continue;
    }
    const closesBlockComment =
      state === 'block-comment' && char === '*' && next === '/';
    if (closesBlockComment) {
      chars[index] = chars[index + 1] = ' ';
      index += 1;
      state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      chars[index] = BLANK_EXCEPT_NEWLINE[char === '\n'];
      continue;
    }
    const escapedString = state === 'string' && char === '\\';
    if (escapedString) {
      chars[index] = ' ';
      chars[index + 1] = BLANK_EXCEPT_NEWLINE[chars[index + 1] === '\n'];
      index += 1;
      continue;
    }
    const closesString = state === 'string' && char === quote;
    if (closesString) {
      chars[index] = ' ';
      state = 'code';
      continue;
    }
    if (state === 'string') {
      chars[index] = BLANK_EXCEPT_NEWLINE[char === '\n'];
      continue;
    }
    const commentState = char === '/' ? COMMENT_STATES[next] : undefined;
    if (commentState) {
      chars[index] = chars[index + 1] = ' ';
      index += 1;
      state = commentState;
      continue;
    }
    if (family === 'python' && char === '#') {
      chars[index] = ' ';
      state = 'line-comment';
      continue;
    }
    if (stringQuotes.includes(char)) {
      quote = char;
      chars[index] = ' ';
      state = 'string';
    }
  }
  return chars.join('');
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1)
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function matchingBrace(source, open, opening = '{', closing = '}') {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function decisionTokens(family) {
  return DECISION_TOKENS[family];
}

function metricsFor(source, family) {
  const decisions = [...source.matchAll(decisionTokens(family))];
  let cognitive = 0;
  for (const decision of decisions) {
    const before = source.slice(0, decision.index);
    let nesting = 0;
    if (family === 'python') {
      const line = before.slice(before.lastIndexOf('\n') + 1);
      nesting = Math.max(
        0,
        Math.floor((line.match(/^\s*/u)?.[0].length || 0) / 4) - 1,
      );
    } else {
      nesting = Math.max(
        0,
        (before.match(/\{/gu) || []).length -
          (before.match(/\}/gu) || []).length -
          1,
      );
    }
    cognitive += 1 + nesting;
  }
  return {
    cognitive,
    cyclomatic: 1 + decisions.length,
    lines: source ? source.split('\n').length : 0,
  };
}

function pythonFunctionEnd(lines, starts, stripped, index, match, multiline) {
  const indent = match[1].replaceAll('\t', '    ').length;
  const signatureOpen = starts[index] + lines[index].indexOf('(', match.index);
  const signatureClose = matchingBrace(stripped, signatureOpen, '(', ')');
  const signatureTail = stripped.slice(signatureClose);
  let end = multiline
    ? lineAt(
        starts,
        signatureClose + Math.max(0, signatureTail.search(/:\s*(?:\n|$)/u)),
      )
    : index + 1;
  const boundary = new RegExp(
    `^ {0,${indent}}${multiline ? '\\S' : '[^\\s@#]'}`,
    'u',
  );
  while (
    end < lines.length &&
    !boundary.test(lines[end].replaceAll('\t', '    '))
  )
    end += 1;
  return end;
}

function pythonFunctions(source, stripped, options = {}) {
  const lines = stripped.split('\n');
  const original = source.split('\n');
  const starts = lineStarts(stripped);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u.exec(
      lines[index],
    );
    if (!match) continue;
    const multiline = options.extractorAlgorithm === 'python-multiline-v2';
    const end = pythonFunctionEnd(
      lines,
      starts,
      stripped,
      index,
      match,
      multiline,
    );
    const selected = lines.slice(index, end);
    results.push({
      symbol: match[2],
      startLine: index + 1,
      endLine: Math.max(index + 1, end),
      body: original.slice(index, end).join('\n'),
      strippedBody: multiline
        ? selected.map((line) => line.slice(match[1].length)).join('\n')
        : selected.join('\n'),
    });
  }
  return results;
}

function bracedFunctions(source, stripped, family) {
  const starts = lineStarts(stripped);
  const seen = new Set();
  const results = [];
  for (const pattern of BRACED_FUNCTION_PATTERNS[family]) {
    for (const match of stripped.matchAll(pattern)) {
      const symbol = match[1];
      if (EXCLUDED_BRACED_SYMBOLS.has(symbol)) continue;
      const open = match.index + match[0].lastIndexOf('{');
      if (seen.has(open)) continue;
      seen.add(open);
      const close = matchingBrace(stripped, open);
      results.push({
        symbol,
        startLine: lineAt(starts, match.index),
        endLine: lineAt(starts, close),
        body: source.slice(match.index, close + 1),
        strippedBody: stripped.slice(match.index, close + 1),
      });
    }
  }
  return results.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.symbol.localeCompare(right.symbol),
  );
}

function extractFunctions(file, layers, ownership, options = {}) {
  const family = languageFamily(file.path);
  if (!family) return [];
  const source = file.bytes.toString('utf8');
  const stripped = stripStringsAndComments(source, family);
  const extracted =
    family === 'python'
      ? pythonFunctions(source, stripped, options)
      : bracedFunctions(source, stripped, family);
  return extracted.map((item) => {
    const metrics = metricsFor(item.strippedBody, family);
    const bodyRoot = digest(
      Buffer.from(item.strippedBody.replace(/\s+/gu, ' ').trim()),
    );
    return {
      id: `${family}:${file.path}:${item.symbol}:${item.startLine}`,
      path: file.path,
      symbol: item.symbol,
      language: family,
      owner: ownerFor(file.path, layers, ownership),
      startLine: item.startLine,
      endLine: item.endLine,
      lines: metrics.lines,
      cyclomatic: metrics.cyclomatic,
      cognitive: metrics.cognitive,
      bodyRoot,
      baseRisk:
        metrics.cyclomatic +
        2 * metrics.cognitive +
        Math.ceil(Math.log2(metrics.lines + 1)),
    };
  });
}

function functionSnapshot(files, policy, layers, ownership, options = {}) {
  const all = files
    .filter(({ path: pathname }) => languageFamily(pathname))
    .map((file) => ({
      ...file,
      class: classify(file.path, file.bytes),
      generatedProvenance: hasGeneratedProvenance(file.path, file.bytes),
      language: languageFamily(file.path),
      contentRoot: digest(file.bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const included = all.filter((file) =>
    policy.includedClasses.includes(file.class),
  );
  const functions = included
    .flatMap((file) => extractFunctions(file, layers, ownership, options))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fileFacts = all.map(({ bytes: _bytes, ...fact }) => fact);
  return { sourceRoot: digest(fileFacts), files: fileFacts, functions };
}

function validatedAnalysisIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    throw new Error('source analysis cache identity must be an object');
  for (const field of ['sourceCommit', 'sourceTree', 'baselineRevision'])
    if (!REVISION_PATTERN.test(String(identity[field] || '')))
      throw new Error(`source analysis cache identity has invalid ${field}`);
  for (const field of [
    'sourceStatusRoot',
    'policyRoot',
    'inputContractRoot',
    'implementationRoot',
  ])
    if (!ROOT_PATTERN.test(String(identity[field] || '')))
      throw new Error(`source analysis cache identity has invalid ${field}`);
  return ordered(identity);
}

function analysisCacheRoot(runtimeRoot) {
  if (!runtimeRoot) return null;
  const resolved = path.resolve(runtimeRoot);
  const relative = path.relative(ROOT, resolved);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
    throw new Error(
      'source analysis cache runtime must stay outside the checkout',
    );
  return path.join(resolved, 'quality-analysis-cache');
}

function analysisCachePath(namespace, identity, options = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(namespace))
    throw new Error('source analysis cache namespace is invalid');
  const root = analysisCacheRoot(
    options.runtimeRoot ?? process.env.KUNGFU_SOURCE_ACCEPTANCE_RUNTIME_ROOT,
  );
  if (!root) return null;
  const identityRoot = digest(validatedAnalysisIdentity(identity));
  return path.join(
    root,
    namespace,
    `${identityRoot.slice('sha256:'.length)}.json`,
  );
}

function parseAnalysisCache(cachePath, identity) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `source analysis cache is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const canonicalIdentity = validatedAnalysisIdentity(identity);
  const identityRoot = digest(canonicalIdentity);
  if (
    record.schema !== CACHE_SCHEMA ||
    record.authority !== 'disposable-non-authoritative' ||
    record.identityRoot !== identityRoot ||
    digest(record.identity) !== identityRoot ||
    digest(record.payload) !== record.payloadRoot
  )
    throw new Error('source analysis cache identity or payload root mismatch');
  return record.payload;
}

function readThroughAnalysisCache(namespace, identity, producer, options = {}) {
  const cachePath = analysisCachePath(namespace, identity, options);
  if (!cachePath) return { value: producer(), hit: false, path: null };
  if (fs.existsSync(cachePath))
    return {
      value: parseAnalysisCache(cachePath, identity),
      hit: true,
      path: cachePath,
    };
  const value = producer();
  const canonicalIdentity = validatedAnalysisIdentity(identity);
  const record = {
    schema: CACHE_SCHEMA,
    authority: 'disposable-non-authoritative',
    identity: canonicalIdentity,
    identityRoot: digest(canonicalIdentity),
    payload: value,
    payloadRoot: digest(value),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, cachePath);
  return { value, hit: false, path: cachePath };
}

export {
  ROOT,
  analysisCachePath,
  baselineBytes,
  baselineChangedPaths,
  classify,
  currentBytes,
  digest,
  digestBytes,
  extractFunctions,
  functionSnapshot,
  git,
  gitResult,
  gitLines,
  hasGeneratedProvenance,
  isEligible,
  language,
  languageFamily,
  lineCount,
  ordered,
  ownerFor,
  readJson,
  readThroughAnalysisCache,
  stripStringsAndComments,
  trackedCurrentFiles,
  trackedFilesAt,
};
