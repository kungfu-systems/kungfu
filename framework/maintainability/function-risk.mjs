#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  classify,
  hasGeneratedProvenance,
  language,
  ownerFor,
} from '../../scripts/code-complexity-budget.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'framework/maintainability/function-risk-policy.json';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
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

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  return result.stdout;
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function trackedCurrentFiles() {
  return String(runGit(['ls-files', '-z']))
    .split('\0')
    .filter(Boolean)
    .map((pathname) => ({
      path: pathname,
      bytes: fs.readFileSync(path.join(ROOT, pathname)),
    }));
}

function trackedFilesAt(ref) {
  const entries = String(
    runGit(['ls-tree', '-r', '-z', '--format=%(objectname)%x09%(path)', ref]),
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { oid: entry.slice(0, tab), path: entry.slice(tab + 1) };
    });
  const selected = entries.filter(({ path: pathname }) =>
    Boolean(languageFamily(pathname)),
  );
  if (!selected.length) return [];
  const output = /** @type {Buffer} */ (
    runGit(['cat-file', '--batch'], {
      binary: true,
      input: Buffer.from(`${selected.map(({ oid }) => oid).join('\n')}\n`),
    })
  );
  let offset = 0;
  return selected.map(({ path: pathname }) => {
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

function languageFamily(pathname) {
  const value = language(pathname);
  return ['c-cpp', 'javascript-typescript', 'python', 'rust'].includes(value)
    ? value
    : '';
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
  const lines = source ? source.split('\n').length : 0;
  return { cognitive, cyclomatic: 1 + decisions.length, lines };
}

function normalizedBody(source) {
  return source.replace(/\s+/gu, ' ').trim();
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
      const open =
        /** @type {number} */ (match.index) + match[0].lastIndexOf('{');
      if (seen.has(open)) continue;
      seen.add(open);
      const close = matchingBrace(stripped, open);
      results.push({
        symbol,
        startLine: lineAt(starts, /** @type {number} */ (match.index)),
        endLine: lineAt(starts, close),
        body: source.slice(/** @type {number} */ (match.index), close + 1),
        strippedBody: stripped.slice(
          /** @type {number} */ (match.index),
          close + 1,
        ),
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
    const bodyRoot = digest(Buffer.from(normalizedBody(item.strippedBody)));
    const risk =
      metrics.cyclomatic +
      2 * metrics.cognitive +
      Math.ceil(Math.log2(metrics.lines + 1));
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
      baseRisk: risk,
    };
  });
}

function snapshot(files, policy, layers, ownership) {
  const all = files
    .filter(({ path: pathname }) => languageFamily(pathname))
    .map((file) => {
      const fileClass = classify(file.path, file.bytes);
      return {
        ...file,
        class: fileClass,
        generatedProvenance: hasGeneratedProvenance(file.path, file.bytes),
        language: languageFamily(file.path),
        contentRoot: digest(file.bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const included = all.filter((file) =>
    policy.includedClasses.includes(file.class),
  );
  const functions = included
    .flatMap((file) => extractFunctions(file, layers, ownership))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fileFacts = all.map(({ bytes: _bytes, ...fact }) => fact);
  return {
    sourceRoot: digest(fileFacts),
    files: fileFacts,
    functions,
  };
}

function uniqueBy(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const value = key(item);
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(item);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length === 1)
      .map(([value, values]) => [value, values[0]]),
  );
}

function analyzeTransition(
  current,
  baseline,
  currentFiles,
  baselineFiles,
  policy,
) {
  const exact = new Map(
    baseline.map((item) => [`${item.path}\0${item.symbol}`, item]),
  );
  const uniqueSymbols = uniqueBy(baseline, (item) => item.symbol);
  const matchedBaseline = new Set();
  const transitions = [];
  const functions = current.map((item) => {
    const previous =
      exact.get(`${item.path}\0${item.symbol}`) ||
      uniqueSymbols.get(item.symbol) ||
      null;
    if (previous) matchedBaseline.add(previous.id);
    const movement = !previous
      ? 'new'
      : previous.language !== item.language
        ? 'cross-language'
        : previous.path !== item.path
          ? 'renamed-file'
          : 'same-path';
    const changed = !previous || previous.bodyRoot !== item.bodyRoot;
    const changeWeight = changed ? 3 : 0;
    const movementWeight = ['renamed-file', 'cross-language'].includes(movement)
      ? 2
      : 0;
    const changeRisk = Math.max(
      item.baseRisk + changeWeight + movementWeight,
      previous?.changeRisk || previous?.baseRisk || 0,
    );
    if (previous && (changed || movement !== 'same-path'))
      transitions.push({
        symbol: item.symbol,
        from: previous.id,
        to: item.id,
        movement,
        complexityDelta:
          item.cyclomatic +
          item.cognitive -
          (previous.cyclomatic + previous.cognitive),
      });
    return { ...item, changeRisk, movement, previousId: previous?.id || null };
  });
  const findings = [];
  const newByOwner = new Map();
  for (const item of functions.filter(({ movement }) => movement === 'new')) {
    if (!newByOwner.has(item.owner)) newByOwner.set(item.owner, []);
    newByOwner.get(item.owner).push(item);
  }
  for (const item of functions) {
    if (!item.previousId) continue;
    const previous = baseline.find(({ id }) => id === item.previousId);
    const drop =
      previous.cyclomatic +
      previous.cognitive -
      (item.cyclomatic + item.cognitive);
    const helperTotal = (newByOwner.get(item.owner) || []).reduce(
      (sum, helper) => sum + helper.cyclomatic + helper.cognitive,
      0,
    );
    if (
      drop >= policy.antiGaming.complexityDropForWrapperSignal &&
      helperTotal >= drop
    )
      findings.push({
        code: 'wrapper-only-extraction',
        severity: 'advisory',
        paths: [
          item.path,
          ...(newByOwner.get(item.owner) || []).map(
            ({ path: pathname }) => pathname,
          ),
        ].sort(),
        message:
          'complexity moved to new same-owner helpers without reducing aggregate responsibility',
      });
  }
  const currentByPath = new Map(currentFiles.map((item) => [item.path, item]));
  for (const previous of baselineFiles) {
    const now = currentByPath.get(previous.path);
    if (
      now &&
      policy.includedClasses.includes(previous.class) &&
      ['generated-projection', 'vendored-source'].includes(now.class)
    )
      findings.push({
        code: 'generated-or-vendor-relabeling',
        severity: 'advisory',
        paths: [previous.path],
        message:
          'first-party function source changed to an excluded generated or vendor class',
      });
  }
  for (const transition of transitions) {
    if (transition.movement === 'renamed-file')
      findings.push({
        code: 'file-rename-risk-preserved',
        severity: 'advisory',
        paths: [transition.from, transition.to],
        message: 'function risk remains anchored across a file rename',
      });
    if (transition.movement === 'cross-language')
      findings.push({
        code: 'cross-language-risk-preserved',
        severity: 'advisory',
        paths: [transition.from, transition.to],
        message: 'function risk remains anchored across a language move',
      });
  }
  return {
    functions,
    transitions: transitions.sort((left, right) =>
      left.to.localeCompare(right.to),
    ),
    findings: findings.sort((left, right) =>
      `${left.code}\0${left.paths.join('\0')}`.localeCompare(
        `${right.code}\0${right.paths.join('\0')}`,
      ),
    ),
    retiredFunctions: baseline
      .filter(({ id }) => !matchedBaseline.has(id))
      .map(({ id }) => id)
      .sort(),
  };
}

function entrypointGraph(policy) {
  const packageDocument = readJson('package.json');
  const selector = new RegExp(
    policy.entrypointMapping.packageScriptSelector,
    'u',
  );
  const discoveredScripts = Object.keys(packageDocument.scripts)
    .filter((name) => selector.test(name))
    .sort();
  const mappedScripts = Object.keys(
    policy.entrypointMapping.packageScripts,
  ).sort();
  if (discoveredScripts.join('\0') !== mappedScripts.join('\0'))
    throw new Error(
      `maintainability package-script mapping drift: discovered [${discoveredScripts.join(', ')}], mapped [${mappedScripts.join(', ')}]`,
    );
  const workflowSelector = new RegExp(
    policy.entrypointMapping.workflowSelector,
    'u',
  );
  const discoveredWorkflows = String(
    runGit(['ls-files', '.github/workflows/*.yml']),
  )
    .split('\n')
    .filter(Boolean)
    .filter((relative) =>
      workflowSelector.test(fs.readFileSync(path.join(ROOT, relative), 'utf8')),
    )
    .sort();
  const mappedWorkflows = Object.keys(
    policy.entrypointMapping.workflows,
  ).sort();
  if (discoveredWorkflows.join('\0') !== mappedWorkflows.join('\0'))
    throw new Error(
      `maintainability workflow mapping drift: discovered [${discoveredWorkflows.join(', ')}], mapped [${mappedWorkflows.join(', ')}]`,
    );
  const registry = readJson('shifu.gates.json');
  const gateIds = new Set(registry.gates.map(({ id }) => id));
  const profileIds = new Set(registry.profiles.map(({ id }) => id));
  for (const mapping of [
    ...Object.values(policy.entrypointMapping.packageScripts),
    ...Object.values(policy.entrypointMapping.workflows),
  ]) {
    if (mapping.gate && !gateIds.has(mapping.gate))
      throw new Error(`unknown mapped Gate '${mapping.gate}'`);
    if (mapping.profile && !profileIds.has(mapping.profile))
      throw new Error(`unknown mapped profile '${mapping.profile}'`);
    if (!['canonical-gate', 'retained-exception'].includes(mapping.disposition))
      throw new Error(
        `invalid entrypoint disposition '${mapping.disposition}'`,
      );
  }
  const routeInventory = readJson(
    'framework/maintainability/readonly-source-routes.json',
  );
  const routeCommands = new Set(
    routeInventory.routes.map(
      ({ command }) => command.split(' ')[1] || command.split(' ')[0],
    ),
  );
  for (const command of policy.entrypointMapping.readonlyRoutes)
    if (!routeCommands.has(command))
      throw new Error(`missing read-only route '${command}'`);
  const body = {
    packageScripts: policy.entrypointMapping.packageScripts,
    workflows: policy.entrypointMapping.workflows,
    readonlyRoutes: policy.entrypointMapping.readonlyRoutes,
  };
  return { ...body, graphRoot: digest(body) };
}

function buildReport() {
  const policy = readJson(POLICY_PATH);
  const layers = readJson('framework/core/architecture/layers.json');
  const ownership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const baselineRevision = String(
    runGit(['rev-parse', `${policy.baselineRef}^{commit}`]),
  ).trim();
  if (baselineRevision !== policy.baselineRef)
    throw new Error('function-risk baselineRef must be an exact commit SHA');
  const baseline = snapshot(
    trackedFilesAt(baselineRevision),
    policy,
    layers,
    ownership,
  );
  const current = snapshot(trackedCurrentFiles(), policy, layers, ownership);
  const transition = analyzeTransition(
    current.functions,
    baseline.functions,
    current.files,
    baseline.files,
    policy,
  );
  const sourceRevision = String(runGit(['rev-parse', 'HEAD^{commit}'])).trim();
  const dirty = Boolean(
    String(
      runGit(['status', '--porcelain=v1', '--untracked-files=all']),
    ).trim(),
  );
  const body = {
    schema: 'kungfu.function-risk-report/v1',
    status: 'advisory',
    enforcement: 'none',
    sourceRevision,
    sourceState: dirty ? 'working-tree' : 'exact-revision',
    sourceRoot: current.sourceRoot,
    policyPath: POLICY_PATH,
    policyRoot: digest(policy),
    baseline: {
      ref: policy.baselineRef,
      revision: baselineRevision,
      sourceRoot: baseline.sourceRoot,
    },
    exclusions: {
      declaredClasses: policy.excludedClasses,
      currentFiles: current.files.filter((file) =>
        policy.excludedClasses.includes(file.class),
      ).length,
    },
    entrypointGraph: entrypointGraph(policy),
    summary: {
      byLanguage: Object.fromEntries(
        Object.keys(policy.languageFamilies)
          .sort()
          .map((family) => [
            family,
            transition.functions.filter(
              ({ language: value }) => value === family,
            ).length,
          ]),
      ),
      functions: transition.functions.length,
      findings: transition.findings.length,
      blockingFindings: 0,
    },
    functions: transition.functions,
    transitions: transition.transitions,
    retiredFunctions: transition.retiredFunctions,
    findings: transition.findings,
  };
  return { ...body, reportRoot: digest(body) };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const unknown = argv.filter((arg) => !['--json', '--check'].includes(arg));
  if (unknown.length) throw new Error(`unknown argument '${unknown[0]}'`);
  const report = buildReport();
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else
    process.stdout.write(
      `pass: ${report.schema}; ${report.summary.functions} functions, ${report.summary.findings} advisory findings, 0 blocking\n`,
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `function-risk: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export {
  analyzeTransition,
  buildReport,
  digest,
  extractFunctions,
  stripStringsAndComments,
};
