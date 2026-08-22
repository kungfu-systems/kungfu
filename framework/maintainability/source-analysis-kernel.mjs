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
  process.env.KUNGFU_GIT_COMMAND_TIMEOUT_MS || 10_000,
);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CACHE_SCHEMA = 'kungfu.source-analysis-cache/v1';

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
    matchesAny(pathname, [
      'docs/qualification/evidence/',
      '/evidence/',
      '/qualification/reports/',
      '/retained/',
    ])
  )
    return 'retained-evidence';
  if (
    matchesAny(pathname, [
      'framework/core/.deps/',
      '/node_modules/',
      '/third_party/',
      '/third-party/',
      '/vendor/',
      '/vendored/',
    ])
  )
    return 'vendored-source';
  if (
    /(?:^|[/_.-])generated(?:[/_.-]|$)/u.test(pathname) ||
    generatedMarker(bytes)
  )
    return 'generated-projection';
  if (
    /(?:^|\/)(?:test|tests|fixtures?|__tests__)(?:\/|$)/u.test(pathname) ||
    /(?:^|[._-])test(?:[._-]|$)/u.test(basename) ||
    /(?:^|[._-])spec(?:[._-]|$)/u.test(basename) ||
    /^test_/u.test(basename)
  )
    return 'test-or-fixture';
  if (
    [
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
    ].includes(extension) ||
    extension === '.cmake' ||
    basename === 'CMakeLists.txt'
  )
    return 'declarative-schema-or-table';
  if (
    (/\/include\//u.test(pathname) &&
      ['.h', '.hh', '.hpp', '.hxx'].includes(extension)) ||
    /(?:^|\/)(?:main|index|__init__)\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|cjs|ts|tsx|py|rs)$/u.test(
      pathname,
    ) ||
    pathname === 'shifu' ||
    pathname === 'shifu.cmd'
  )
    return 'public-header-or-entrypoint';
  if (
    [
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
    ].includes(extension)
  )
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
  if (declared.length === 1) return declared[0].owner;
  if (declared.length > 1) return '';
  if (pathname.startsWith('framework/core/')) {
    const relative = pathname.slice('framework/core/'.length);
    const owners = layers.components.filter((component) =>
      owns(component, relative),
    );
    if (owners.length === 1) return owners[0].owner;
    if (pathname.startsWith('framework/core/architecture/'))
      return 'core/architecture';
    if (pathname.startsWith('framework/core/tests/'))
      return 'core/qualification';
    if (
      pathname.startsWith('framework/core/.gyp/') ||
      pathname === 'framework/core/conanfile.py' ||
      pathname === 'framework/core/CMakeLists.txt'
    )
      return 'core/build';
    if (pathname.startsWith('framework/core/lib/')) return 'core/bindings';
    return owners.length > 1 ? '' : 'core/package';
  }
  const segments = pathname.split('/');
  const top = segments[0];
  if (top === 'framework' && segments[1]) return `framework/${segments[1]}`;
  if (top === 'extensions' && segments[1])
    return `extension/${segments.slice(1, Math.min(3, segments.length - 1)).join('/') || segments[1]}`;
  if (top === 'crates' && segments[1]) return `crate/${segments[1]}`;
  if (top === 'developer' && segments[1]) return `developer/${segments[1]}`;
  if (top === 'product') return 'product/assembly';
  if (top === 'scripts' || pathname === 'shifu' || pathname === 'shifu.cmd')
    return 'shifu/source-tooling';
  if (top === 'docs') return 'kungfu/docs';
  if (top === '.github') return 'kungfu/release-workflow';
  if (top === 'config') return 'kungfu/config';
  if (top === 'tests') return 'kungfu/qualification';
  if (top === 'examples') return 'kungfu/examples';
  if (top === 'types') return 'kungfu/public-types';
  if (top === '.kungfu') return 'kungfu/retained-native-evidence';
  if (
    [
      '.buildchain',
      '.xinfa',
      'package.json',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'Cargo.toml',
    ].includes(top)
  )
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
  let state = 'code';
  let quote = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1] || '';
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        chars[index] = chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }
    if (state === 'string') {
      if (char === '\\') {
        chars[index] = ' ';
        if (chars[index + 1] !== '\n') chars[index + 1] = ' ';
        index += 1;
      } else if (char === quote) {
        chars[index] = ' ';
        state = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }
    if (char === '/' && next === '/') {
      chars[index] = chars[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      chars[index] = chars[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (family === 'python' && char === '#') {
      chars[index] = ' ';
      state = 'line-comment';
    } else if (
      char === '"' ||
      char === "'" ||
      (char === '`' && family === 'javascript-typescript')
    ) {
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

function matchingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function decisionTokens(family) {
  if (family === 'python')
    return /\b(?:if|elif|for|while|except|case|and|or)\b/gu;
  if (family === 'rust') return /\b(?:if|for|while|match)\b|&&|\|\||=>/gu;
  return /\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/gu;
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

function pythonFunctions(source, stripped) {
  const lines = stripped.split('\n');
  const original = source.split('\n');
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u.exec(
      lines[index],
    );
    if (!match) continue;
    const indent = match[1].replaceAll('\t', '    ').length;
    let end = index + 1;
    while (end < lines.length) {
      if (!lines[end].trim()) {
        end += 1;
        continue;
      }
      const nextIndent = (lines[end].match(/^\s*/u)?.[0] || '').replaceAll(
        '\t',
        '    ',
      ).length;
      if (nextIndent <= indent && !/^\s*[@#]/u.test(lines[end])) break;
      end += 1;
    }
    results.push({
      symbol: match[2],
      startLine: index + 1,
      endLine: Math.max(index + 1, end),
      body: original.slice(index, end).join('\n'),
      strippedBody: lines.slice(index, end).join('\n'),
    });
  }
  return results;
}

function bracedFunctions(source, stripped, family) {
  const starts = lineStarts(stripped);
  const patterns =
    family === 'javascript-typescript'
      ? [
          /\b(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\([^\n)]*\)[ \t]*\{/gu,
          /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\([^\n)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>[ \t]*\{/gu,
          /(?:^|\n)[ \t]*(?:async[ \t]+)?(?:static[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^;{}\n]*\)[ \t]*(?::[ \t]*[^={\n]+)?\{/gu,
        ]
      : family === 'rust'
        ? [
            /\bfn[ \t]+([A-Za-z_]\w*)[ \t]*(?:<[^>{}\n]*>)?[ \t]*\([^\n)]*\)[^{;\n]*\{/gu,
          ]
        : [
            /(?:^|\n)[ \t]*(?:template[ \t]*<[^;{}\n]*>[ \t]*)?(?:[\w:&*<>~,\[\]][\w:&*<>~,\[\] \t]*[ \t]+)?([~A-Za-z_]\w*(?:::\w+)*)[ \t]*\([^;{}\n]*\)[ \t]*(?:const[ \t]*)?(?:noexcept[ \t]*)?(?:->[ \t]*[^{}\n]+)?\{/gu,
          ];
  const excluded = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'sizeof',
  ]);
  const seen = new Set();
  const results = [];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const symbol = match[1];
      if (excluded.has(symbol)) continue;
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

function extractFunctions(file, layers, ownership) {
  const family = languageFamily(file.path);
  if (!family) return [];
  const source = file.bytes.toString('utf8');
  const stripped = stripStringsAndComments(source, family);
  const extracted =
    family === 'python'
      ? pythonFunctions(source, stripped)
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

function functionSnapshot(files, policy, layers, ownership) {
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
    .flatMap((file) => extractFunctions(file, layers, ownership))
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
