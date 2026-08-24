// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceAcceptancePlan } from '../../scripts/source-acceptance.mjs';

import {
  extractFunctions as extractLegacyFunctions,
  snapshot as legacySnapshot,
  trackedCurrentFiles as legacyTrackedCurrentFiles,
  trackedFilesAt as legacyTrackedFilesAt,
} from './fixtures/function-risk-legacy-shadow.mjs';
import {
  evaluateFunctionRiskRatchet,
  runFunctionRiskGate,
} from './function-risk-ratchet.mjs';
import {
  analyzeTransition,
  buildReport,
  digest,
  extractFunctions,
} from './function-risk.mjs';
import {
  analysisCachePath,
  classify,
  extractFunctions as extractKernelFunctions,
  functionSnapshot as kernelFunctionSnapshot,
  ownerFor,
  readJson,
  readThroughAnalysisCache,
  stripStringsAndComments,
  trackedCurrentFiles,
  trackedFilesAt,
} from './source-analysis-kernel.mjs';
import { functionSnapshot } from './source-analysis-session.mjs';

const layers = { components: [] };
const ownership = [];
const responsibilityMap = JSON.parse(
  fs.readFileSync(
    new URL('./quality-governance-responsibility-map.json', import.meta.url),
    'utf8',
  ),
);
const policy = {
  includedClasses: ['first-party-handwritten-implementation'],
  antiGaming: { complexityDropForWrapperSignal: 3 },
};
const ratchetPolicy = {
  newFunctionBaseRiskEnvelope: {
    'c-cpp': 52,
    'javascript-typescript': 87,
    python: 56,
    rust: 63,
  },
};

function metric(overrides = {}) {
  const item = {
    id: 'javascript-typescript:scripts/a.mjs:work:1',
    path: 'scripts/a.mjs',
    symbol: 'work',
    language: 'javascript-typescript',
    owner: 'shifu/source-tooling',
    startLine: 1,
    endLine: 8,
    lines: 8,
    cyclomatic: 5,
    cognitive: 5,
    bodyRoot: digest('body'),
    baseRisk: 18,
    ...overrides,
  };
  return item;
}

test('extracts rooted function metrics for all four declared language families', () => {
  const fixtures = [
    [
      'framework/a.py',
      'def work(value):\n    if value:\n        return value\n    return 0\n',
      'python',
    ],
    [
      'scripts/a.ts',
      'export function work(value: number) { if (value) return value; return 0; }\n',
      'javascript-typescript',
    ],
    [
      'crates/a/src/lib.rs',
      'pub fn work(value: i32) -> i32 { if value > 0 { value } else { 0 } }\n',
      'rust',
    ],
    [
      'framework/core/src/libkungfu/a.cpp',
      'int work(int value) { if (value > 0) { return value; } return 0; }\n',
      'c-cpp',
    ],
  ];
  for (const [pathname, source, family] of fixtures) {
    const file = { path: pathname, bytes: Buffer.from(source) };
    const legacyFunctions = extractLegacyFunctions(file, layers, ownership);
    const functions = extractKernelFunctions(file, layers, ownership);
    assert.deepEqual(
      functions,
      legacyFunctions,
      `${pathname} kernel shadow parity`,
    );
    assert.deepEqual(extractFunctions(file, layers, ownership), functions);
    assert.equal(functions.length, 1, pathname);
    assert.equal(functions[0].language, family);
    assert.equal(functions[0].symbol, 'work');
    assert.ok(functions[0].cyclomatic >= 2);
    assert.match(functions[0].bodyRoot, /^sha256:[0-9a-f]{64}$/u);
  }
});

test('source-analysis tables preserve classification, ownership, and lexical boundaries', () => {
  const classifications = [
    ['docs/qualification/evidence/run.json', 'retained-evidence'],
    ['framework/core/.deps/library.cpp', 'vendored-source'],
    ['framework/generated/model.ts', 'generated-projection'],
    ['framework/example/value.spec.ts', 'test-or-fixture'],
    ['config/example.yaml', 'declarative-schema-or-table'],
    ['framework/example/include/value.hpp', 'public-header-or-entrypoint'],
    ['framework/example/value.mjs', 'first-party-handwritten-implementation'],
    ['docs/example.md', ''],
  ];
  for (const [pathname, expected] of classifications)
    assert.equal(classify(pathname, Buffer.from('')), expected, pathname);

  const componentLayers = {
    components: [
      {
        owner: 'core/runtime',
        include_prefixes: ['src/'],
      },
    ],
  };
  assert.equal(
    ownerFor('framework/core/src/runtime.cpp', componentLayers),
    'core/runtime',
  );
  assert.equal(
    ownerFor('framework/core/architecture/layers.json', componentLayers),
    'core/architecture',
  );
  assert.equal(
    ownerFor('extensions/market-data/src/index.ts', componentLayers),
    'extension/market-data/src',
  );
  assert.equal(
    ownerFor('scripts/check.mjs', componentLayers),
    'shifu/source-tooling',
  );
  assert.equal(
    ownerFor('custom/source.cpp', componentLayers, [
      { owner: 'first', paths: ['custom/source.cpp'] },
      { owner: 'second', paths: ['custom/source.cpp'] },
    ]),
    '',
  );

  assert.equal(
    stripStringsAndComments('"x" //y\n/*z*/ code', 'javascript-typescript'),
    '       \n      code',
  );
  assert.equal(
    stripStringsAndComments("value = '#'; # note\nnext = 1", 'python'),
    'value =    ;       \nnext = 1',
  );
  assert.equal(
    stripStringsAndComments('let value = `x`;', 'javascript-typescript'),
    'let value =    ;',
  );
  assert.equal(stripStringsAndComments('`x`', 'rust'), '`x`');
  assert.equal(stripStringsAndComments('"x"', 'unknown'), '   ');
});

test('python multiline v2 follows the closing signature into the indented body', () => {
  const file = {
    path: 'framework/a.py',
    bytes: Buffer.from(
      [
        'def work(',
        '    first,',
        '    second,',
        '):',
        '    if first:',
        '        return second',
        '    return None',
        '',
        '@decorated',
        'def next_work():',
        '    return 1',
        '',
      ].join('\n'),
    ),
  };
  const legacy = extractKernelFunctions(file, layers, ownership);
  const v2 = extractKernelFunctions(file, layers, ownership, {
    extractorAlgorithm: 'python-multiline-v2',
  });
  assert.equal(legacy[0].endLine, 3);
  assert.equal(v2[0].endLine, 8);
  assert.equal(v2[0].cyclomatic, 2);
  assert.equal(v2[0].cognitive, 1);
  assert.equal(v2[1].symbol, 'next_work');
  assert.equal(v2[1].startLine, 10);
});

test('python multiline v2 normalizes class indentation for stable moved bodies', () => {
  const topLevel = {
    path: 'framework/top.py',
    bytes: Buffer.from(
      'def work(value):\n    if value:\n        return value\n    return None\n',
    ),
  };
  const classMethod = {
    path: 'framework/class.py',
    bytes: Buffer.from(
      'class Owner:\n    def work(value):\n        if value:\n            return value\n        return None\n',
    ),
  };
  const options = { extractorAlgorithm: 'python-multiline-v2' };
  const first = extractKernelFunctions(topLevel, layers, ownership, options)[0];
  const second = extractKernelFunctions(
    classMethod,
    layers,
    ownership,
    options,
  )[0];
  assert.equal(second.bodyRoot, first.bodyRoot);
  assert.equal(second.baseRisk, first.baseRisk);
  assert.equal(second.cognitive, first.cognitive);
});

test('shared kernel shadows the legacy exact-repository analysis', () => {
  const policy = readJson(
    'framework/maintainability/function-risk-policy.json',
  );
  const repositoryLayers = readJson('framework/core/architecture/layers.json');
  const repositoryOwnership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const report = buildReport();
  const legacyBaselineInputs = legacyTrackedFilesAt(report.baseline.revision);
  const legacyCurrentInputs = legacyTrackedCurrentFiles();
  const legacyBaseline = legacySnapshot(
    legacyBaselineInputs,
    policy,
    repositoryLayers,
    repositoryOwnership,
  );
  const legacyCurrent = legacySnapshot(
    legacyCurrentInputs,
    policy,
    repositoryLayers,
    repositoryOwnership,
  );
  const successorBaseline = kernelFunctionSnapshot(
    trackedFilesAt(report.baseline.revision),
    policy,
    repositoryLayers,
    repositoryOwnership,
  );
  const successorCurrent = kernelFunctionSnapshot(
    trackedCurrentFiles(),
    policy,
    repositoryLayers,
    repositoryOwnership,
  );
  assert.deepEqual(successorBaseline, legacyBaseline);
  assert.deepEqual(successorCurrent, legacyCurrent);
  const legacyTransition = analyzeTransition(
    legacyCurrent.functions,
    legacyBaseline.functions,
    legacyCurrent.files,
    legacyBaseline.files,
    policy,
    {
      movementScope: 'same-owner',
      movementIdentity: 'body-root',
      sourceFiles: legacyCurrentInputs,
    },
  );
  const successorTransition = analyzeTransition(
    successorCurrent.functions,
    successorBaseline.functions,
    successorCurrent.files,
    successorBaseline.files,
    policy,
    {
      movementScope: 'same-owner',
      movementIdentity: 'body-root',
      sourceFiles: legacyCurrentInputs,
    },
  );
  assert.deepEqual(successorTransition, legacyTransition);
  assert.equal(successorCurrent.sourceRoot, report.sourceRoot);
  assert.equal(successorBaseline.sourceRoot, report.baseline.sourceRoot);
  assert.deepEqual(successorTransition.functions, report.functions);
  assert.deepEqual(successorTransition.transitions, report.transitions);
  assert.deepEqual(
    successorTransition.retiredFunctions,
    report.retiredFunctions,
  );
  assert.deepEqual(successorTransition.findings, report.findings);
});

test('source analysis cache reuses only exact rooted inputs and fails closed', () => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-source-analysis-cache-'),
  );
  const identity = {
    sourceCommit: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    sourceStatusRoot: `sha256:${'3'.repeat(64)}`,
    baselineRevision: '4'.repeat(40),
    policyRoot: `sha256:${'5'.repeat(64)}`,
    inputContractRoot: `sha256:${'6'.repeat(64)}`,
    implementationRoot: `sha256:${'7'.repeat(64)}`,
  };
  let builds = 0;
  const produce = () => ({ findings: [], build: ++builds });
  try {
    const first = readThroughAnalysisCache('fixture', identity, produce, {
      runtimeRoot,
    });
    const second = readThroughAnalysisCache('fixture', identity, produce, {
      runtimeRoot,
    });
    assert.equal(first.hit, false);
    assert.equal(second.hit, true);
    assert.deepEqual(second.value, first.value);
    assert.equal(builds, 1);
    const cachePath = analysisCachePath('fixture', identity, { runtimeRoot });
    fs.writeFileSync(cachePath, '{}\n');
    assert.throws(
      () =>
        readThroughAnalysisCache('fixture', identity, produce, { runtimeRoot }),
      /identity or payload root mismatch/u,
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('wrapper-only extraction remains visible as an advisory signal', () => {
  const baseline = [metric()];
  const current = [
    metric({
      cyclomatic: 1,
      cognitive: 0,
      baseRisk: 4,
      bodyRoot: digest('wrapper'),
    }),
    metric({
      id: 'javascript-typescript:scripts/helper.mjs:helper:1',
      path: 'scripts/helper.mjs',
      symbol: 'helper',
      cyclomatic: 5,
      cognitive: 5,
      bodyRoot: digest('helper'),
    }),
  ];
  const result = analyzeTransition(current, baseline, [], [], policy, {
    sourceFiles: [
      {
        path: 'scripts/a.mjs',
        bytes: Buffer.from('function work() { return helper(); }\n'),
      },
      {
        path: 'scripts/helper.mjs',
        bytes: Buffer.from('function helper() { return 1; }\n'),
      },
    ],
  });
  assert.ok(
    result.findings.some(({ code }) => code === 'wrapper-only-extraction'),
  );
});

test('file renames and cross-language moves preserve risk instead of resetting it', () => {
  const previous = metric({ baseRisk: 30 });
  const renamed = metric({
    id: 'javascript-typescript:scripts/renamed.mjs:work:1',
    path: 'scripts/renamed.mjs',
    baseRisk: 3,
  });
  const rename = analyzeTransition([renamed], [previous], [], [], policy);
  assert.equal(rename.functions[0].movement, 'renamed-file');
  assert.equal(rename.functions[0].changeRisk, 30);
  assert.ok(
    rename.findings.some(({ code }) => code === 'file-rename-risk-preserved'),
  );

  const moved = metric({
    id: 'rust:crates/a/src/lib.rs:work:1',
    path: 'crates/a/src/lib.rs',
    language: 'rust',
    baseRisk: 2,
  });
  const crossLanguage = analyzeTransition([moved], [previous], [], [], policy);
  assert.equal(crossLanguage.functions[0].movement, 'cross-language');
  assert.equal(crossLanguage.functions[0].changeRisk, 30);
  assert.ok(
    crossLanguage.findings.some(
      ({ code }) => code === 'cross-language-risk-preserved',
    ),
  );
});

test('required matching never carries risk across an owner boundary', () => {
  const previous = metric({ owner: 'owner/previous' });
  const current = metric({ owner: 'owner/current', path: 'scripts/b.mjs' });
  const result = analyzeTransition([current], [previous], [], [], policy, {
    movementScope: 'same-owner',
  });
  assert.equal(result.functions[0].movement, 'new');
  assert.equal(result.functions[0].previousId, null);
});

test('advisory movement requires the same owner and exact function body', () => {
  const previous = metric({ owner: 'owner/shared' });
  const unrelated = metric({
    owner: 'owner/shared',
    path: 'scripts/b.mjs',
    bodyRoot: digest('different implementation'),
  });
  const result = analyzeTransition([unrelated], [previous], [], [], policy, {
    movementScope: 'same-owner',
    movementIdentity: 'body-root',
  });
  assert.equal(result.functions[0].movement, 'new');
  assert.equal(result.functions[0].previousId, null);
});

test('changed-code ratchet blocks increases but leaves unchanged historical debt non-blocking', () => {
  const historical = metric({ baseRisk: 200 });
  const unchangedTransition = analyzeTransition(
    [historical],
    [historical],
    [],
    [],
    policy,
    { movementScope: 'same-owner' },
  );
  assert.deepEqual(
    evaluateFunctionRiskRatchet(
      { functions: [historical], files: [] },
      { functions: [historical], files: [] },
      unchangedTransition,
      ratchetPolicy,
    ),
    [],
  );

  const increased = metric({ baseRisk: 19, bodyRoot: digest('changed') });
  const increasedTransition = analyzeTransition(
    [increased],
    [metric()],
    [],
    [],
    policy,
    { movementScope: 'same-owner' },
  );
  const findings = evaluateFunctionRiskRatchet(
    { functions: [increased], files: [] },
    { functions: [metric()], files: [] },
    increasedTransition,
    ratchetPolicy,
  );
  assert.ok(
    findings.some(({ code }) => code === 'changed-function-risk-increase'),
  );
});

test('same-path duplicate symbols match by stable owner occurrence', () => {
  const first = metric({
    id: 'javascript-typescript:scripts/a.mjs:close:10',
    symbol: 'close',
    startLine: 10,
    bodyRoot: digest('first close'),
    baseRisk: 200,
  });
  const second = metric({
    id: 'javascript-typescript:scripts/a.mjs:close:40',
    symbol: 'close',
    startLine: 40,
    bodyRoot: digest('second close'),
    baseRisk: 10,
  });
  const shifted = [
    {
      ...first,
      id: 'javascript-typescript:scripts/a.mjs:close:12',
      startLine: 12,
    },
    {
      ...second,
      id: 'javascript-typescript:scripts/a.mjs:close:42',
      startLine: 42,
    },
  ];
  const unchanged = analyzeTransition(
    shifted,
    [first, second],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.deepEqual(
    unchanged.functions.map(({ previousId }) => previousId),
    [first.id, second.id],
  );
  assert.deepEqual(
    evaluateFunctionRiskRatchet(
      { functions: shifted, files: [] },
      { functions: [first, second], files: [] },
      unchanged,
      ratchetPolicy,
    ),
    [],
  );
  const legacy = analyzeTransition(shifted, [first, second], [], [], policy, {
    movementScope: 'same-owner',
  });
  assert.deepEqual(
    legacy.functions.map(({ previousId }) => previousId),
    [second.id, second.id],
  );

  const withoutFirst = analyzeTransition(
    [shifted[1]],
    [first, second],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.equal(withoutFirst.functions[0].previousId, second.id);

  const changed = [
    shifted[0],
    { ...shifted[1], bodyRoot: digest('changed second close'), baseRisk: 11 },
  ];
  const transition = analyzeTransition(
    changed,
    [first, second],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.ok(
    evaluateFunctionRiskRatchet(
      { functions: changed, files: [] },
      { functions: [first, second], files: [] },
      transition,
      ratchetPolicy,
    ).some(({ code }) => code === 'changed-function-risk-increase'),
  );

  const deletedFirstAndChangedSecond = analyzeTransition(
    [
      {
        ...second,
        id: 'javascript-typescript:scripts/a.mjs:close:42',
        startLine: 42,
        bodyRoot: digest('changed second close after first deletion'),
        baseRisk: 11,
      },
    ],
    [first, second],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.equal(deletedFirstAndChangedSecond.functions[0].previousId, second.id);
  assert.ok(
    evaluateFunctionRiskRatchet(
      { functions: deletedFirstAndChangedSecond.functions, files: [] },
      { functions: [first, second], files: [] },
      deletedFirstAndChangedSecond,
      ratchetPolicy,
    ).some(({ code }) => code === 'changed-function-risk-increase'),
  );

  const movedDeletedAndChanged = analyzeTransition(
    [
      {
        ...second,
        id: 'javascript-typescript:scripts/a.mjs:close:38',
        startLine: 38,
        bodyRoot: digest('changed second close after move and deletion'),
      },
      {
        ...first,
        id: 'javascript-typescript:scripts/a.mjs:close:70',
        startLine: 70,
      },
    ],
    [first, second],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.deepEqual(
    movedDeletedAndChanged.functions.map(({ previousId }) => previousId),
    [second.id, first.id],
  );

  const distanceBaseline = [
    metric({
      id: 'javascript-typescript:scripts/a.mjs:close:1',
      symbol: 'close',
      startLine: 1,
      bodyRoot: digest('distance baseline first'),
      baseRisk: 10,
    }),
    metric({
      id: 'javascript-typescript:scripts/a.mjs:close:11',
      symbol: 'close',
      startLine: 11,
      bodyRoot: digest('distance baseline second'),
      baseRisk: 100,
    }),
  ];
  const distanceCurrent = [
    metric({
      id: 'javascript-typescript:scripts/a.mjs:close:10',
      symbol: 'close',
      startLine: 10,
      bodyRoot: digest('distance current first'),
      baseRisk: 15,
    }),
    metric({
      id: 'javascript-typescript:scripts/a.mjs:close:21',
      symbol: 'close',
      startLine: 21,
      bodyRoot: digest('distance current second'),
      baseRisk: 100,
    }),
  ];
  const minimumDistance = analyzeTransition(
    distanceCurrent,
    distanceBaseline,
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.deepEqual(
    minimumDistance.functions.map(({ previousId }) => previousId),
    distanceBaseline.map(({ id }) => id),
  );
  assert.ok(
    evaluateFunctionRiskRatchet(
      { functions: distanceCurrent, files: [] },
      { functions: distanceBaseline, files: [] },
      minimumDistance,
      ratchetPolicy,
    ).some(({ code }) => code === 'changed-function-risk-increase'),
  );

  const exactSecond = analyzeTransition(
    [
      metric({
        id: 'javascript-typescript:scripts/a.mjs:close:12',
        symbol: 'close',
        startLine: 12,
        bodyRoot: digest('c'),
        baseRisk: 15,
      }),
      {
        ...second,
        id: 'javascript-typescript:scripts/a.mjs:close:22',
        startLine: 22,
      },
    ],
    [
      metric({
        id: 'javascript-typescript:scripts/a.mjs:close:10',
        symbol: 'close',
        startLine: 10,
        bodyRoot: digest('a'),
        baseRisk: 10,
      }),
      { ...second, startLine: 20 },
    ],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.equal(
    exactSecond.functions[0].previousId,
    'javascript-typescript:scripts/a.mjs:close:10',
  );
  assert.equal(exactSecond.functions[1].previousId, second.id);

  const repeatedExactBody = analyzeTransition(
    [
      metric({
        id: 'javascript-typescript:scripts/a.mjs:close:90',
        symbol: 'close',
        startLine: 90,
        bodyRoot: digest('same close body'),
      }),
    ],
    [
      metric({
        id: 'javascript-typescript:scripts/a.mjs:close:10',
        symbol: 'close',
        startLine: 10,
        bodyRoot: digest('same close body'),
      }),
      metric({
        id: 'javascript-typescript:scripts/a.mjs:close:100',
        symbol: 'close',
        startLine: 100,
        bodyRoot: digest('same close body'),
      }),
    ],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.equal(
    repeatedExactBody.functions[0].previousId,
    'javascript-typescript:scripts/a.mjs:close:100',
  );
});

test('qualified occurrence v2 fails closed on ambiguous cross-file identity', () => {
  const baseline = [
    metric({ path: 'scripts/old-a.mjs', id: 'old-a', bodyRoot: digest('a') }),
    metric({ path: 'scripts/old-b.mjs', id: 'old-b', bodyRoot: digest('b') }),
  ];
  const current = [
    metric({ path: 'scripts/new-a.mjs', id: 'new-a', bodyRoot: digest('c') }),
    metric({ path: 'scripts/new-b.mjs', id: 'new-b', bodyRoot: digest('d') }),
  ];
  const transition = analyzeTransition(current, baseline, [], [], policy, {
    identityAlgorithm: 'qualified-occurrence-v2',
    movementScope: 'same-owner',
  });
  assert.ok(
    transition.findings.some(
      ({ code }) => code === 'ambiguous-function-identity',
    ),
  );
  assert.ok(
    evaluateFunctionRiskRatchet(
      { functions: current, files: [] },
      { functions: baseline, files: [] },
      transition,
      ratchetPolicy,
    ).some(({ code }) => code === 'ambiguous-function-identity'),
  );
});

test('qualified occurrence v2 locks unique moved bodies before same-path order matching', () => {
  const baselineA = metric({
    path: 'scripts/a.mjs',
    id: 'baseline-a',
    startLine: 10,
    bodyRoot: digest('body a'),
    baseRisk: 200,
  });
  const baselineB = metric({
    path: 'scripts/a.mjs',
    id: 'baseline-b',
    startLine: 100,
    bodyRoot: digest('body b'),
    baseRisk: 10,
  });
  const changedB = metric({
    path: 'scripts/a.mjs',
    id: 'changed-b',
    startLine: 11,
    bodyRoot: digest('changed body b'),
    baseRisk: 11,
  });
  const movedA = metric({
    path: 'scripts/moved.mjs',
    id: 'moved-a',
    startLine: 1,
    bodyRoot: baselineA.bodyRoot,
    baseRisk: baselineA.baseRisk,
  });
  const transition = analyzeTransition(
    [changedB, movedA],
    [baselineA, baselineB],
    [],
    [],
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  assert.deepEqual(
    transition.functions.map(({ previousId }) => previousId),
    [baselineB.id, baselineA.id],
  );
  assert.ok(
    evaluateFunctionRiskRatchet(
      { functions: [changedB, movedA], files: [] },
      { functions: [baselineA, baselineB], files: [] },
      transition,
      ratchetPolicy,
    ).some(({ code }) => code === 'changed-function-risk-increase'),
  );
});

test('new-function envelopes have positive and negative fixtures', () => {
  const allowed = metric({
    id: 'python:framework/a.py:allowed:1',
    path: 'framework/a.py',
    symbol: 'allowed',
    language: 'python',
    owner: 'framework/a',
    baseRisk: 56,
  });
  const blocked = metric({
    id: 'python:framework/a.py:blocked:10',
    path: 'framework/a.py',
    symbol: 'blocked',
    language: 'python',
    owner: 'framework/a',
    baseRisk: 57,
  });
  const transition = analyzeTransition([allowed, blocked], [], [], [], policy, {
    movementScope: 'same-owner',
  });
  const findings = evaluateFunctionRiskRatchet(
    { functions: [allowed, blocked], files: [] },
    { functions: [], files: [] },
    transition,
    ratchetPolicy,
  );
  assert.deepEqual(
    findings
      .filter(({ code }) => code === 'new-function-risk-envelope-exceeded')
      .map(({ symbol }) => symbol),
    ['blocked'],
  );
});

test('quality-governance changed functions inherit the protected ratchet', () => {
  const allowed = metric({
    id: 'javascript-typescript:framework/maintainability/a.mjs:allowed:1',
    path: 'framework/maintainability/a.mjs',
    symbol: 'allowed',
    owner: 'framework/maintainability',
    baseRisk: 87,
  });
  const blocked = metric({
    id: 'javascript-typescript:framework/maintainability/a.mjs:blocked:10',
    path: 'framework/maintainability/a.mjs',
    symbol: 'blocked',
    owner: 'framework/maintainability',
    baseRisk: 88,
  });
  const transition = analyzeTransition([allowed, blocked], [], [], [], policy, {
    movementScope: 'same-owner',
  });
  const findings = evaluateFunctionRiskRatchet(
    { functions: [allowed, blocked], files: [] },
    { functions: [], files: [] },
    transition,
    ratchetPolicy,
  );
  assert.deepEqual(
    findings
      .filter(({ code }) => code === 'new-function-risk-envelope-exceeded')
      .map(({ symbol }) => symbol),
    ['blocked'],
  );
});

test('same-owner wrapper extraction cannot reset aggregate responsibility', () => {
  const previous = metric();
  const wrapper = metric({ baseRisk: 4, bodyRoot: digest('wrapper') });
  const helper = metric({
    id: 'javascript-typescript:scripts/helper.mjs:helper:1',
    path: 'scripts/helper.mjs',
    symbol: 'helper',
    baseRisk: 18,
  });
  const transition = analyzeTransition(
    [wrapper, helper],
    [previous],
    [],
    [],
    policy,
    { movementScope: 'same-owner' },
  );
  const findings = evaluateFunctionRiskRatchet(
    { functions: [wrapper, helper], files: [] },
    { functions: [previous], files: [] },
    transition,
    ratchetPolicy,
    {
      referencedNewIdsByPreviousId: new Map([
        [previous.id, new Set([helper.id])],
      ]),
    },
  );
  assert.ok(findings.some(({ code }) => code === 'wrapper-only-risk-reset'));
});

test('same-owner rename and unrelated bounded additions remain non-blocking', () => {
  const previous = metric();
  const renamed = metric({
    id: 'javascript-typescript:scripts/renamed.mjs:work:1',
    path: 'scripts/renamed.mjs',
  });
  const unrelated = metric({
    id: 'javascript-typescript:scripts/new.mjs:observe:1',
    path: 'scripts/new.mjs',
    symbol: 'observe',
    baseRisk: 20,
  });
  const transition = analyzeTransition(
    [renamed, unrelated],
    [previous],
    [],
    [],
    policy,
    { movementScope: 'same-owner' },
  );
  assert.equal(transition.functions[0].movement, 'renamed-file');
  assert.equal(transition.functions[1].movement, 'new');
  assert.deepEqual(
    evaluateFunctionRiskRatchet(
      { functions: [renamed, unrelated], files: [] },
      { functions: [previous], files: [] },
      transition,
      ratchetPolicy,
    ),
    [],
  );
});

test('single-process analysis memo extracts an exact file only once', () => {
  const memo = new Map();
  const file = {
    path: 'scripts/a.mjs',
    bytes: Buffer.from('function work(value) { return value; }\n'),
  };
  let extractions = 0;
  const options = {
    analysisMemo: memo,
    onExtract: () => {
      extractions += 1;
    },
  };
  const first = functionSnapshot([file], policy, layers, ownership, options);
  const second = functionSnapshot([file], policy, layers, ownership, options);
  assert.deepEqual(second, first);
  assert.equal(extractions, 1);
});

test('required ratchet failure skips the full advisory phase', () => {
  let advisoryRuns = 0;
  const result = runFunctionRiskGate({
    base: '1'.repeat(40),
    buildRatchet: () => ({
      verdict: 'fail',
      summary: { blockingFindings: 1 },
    }),
    buildAdvisory: () => {
      advisoryRuns += 1;
      return {};
    },
  });
  assert.equal(result.verdict, 'fail');
  assert.equal(result.execution.failFast, true);
  assert.equal(advisoryRuns, 0);
});

test('required fast phase is rooted in the exact evidence base', () => {
  const base = 'a'.repeat(40);
  const plan = sourceAcceptancePlan(['scripts/example.mjs'], base);
  const ratchet = plan.find(({ label }) =>
    label.startsWith('changed-code function-risk ratchet'),
  );
  assert.deepEqual(ratchet?.args, [
    'framework/maintainability/function-risk-ratchet.mjs',
    '--base',
    base,
  ]);
});

test('generated relabeling cannot hide first-party source', () => {
  const result = analyzeTransition(
    [],
    [],
    [{ path: 'scripts/a.mjs', class: 'generated-projection' }],
    [
      {
        path: 'scripts/a.mjs',
        class: 'first-party-handwritten-implementation',
      },
    ],
    policy,
  );
  assert.ok(
    result.findings.some(
      ({ code }) => code === 'generated-or-vendor-relabeling',
    ),
  );
});

test('live report is rooted, advisory, four-language, and maps every entrypoint', () => {
  const report = buildReport();
  assert.equal(report.schema, 'kungfu.function-risk-report/v1');
  assert.equal(report.enforcement, 'none');
  assert.equal(report.summary.blockingFindings, 0);
  assert.deepEqual(Object.keys(report.summary.byLanguage), [
    'c-cpp',
    'javascript-typescript',
    'python',
    'rust',
  ]);
  assert.match(report.reportRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(report.entrypointGraph.graphRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    report.entrypointGraph.workflows['.github/workflows/report-projection.yml']
      .disposition,
    'retained-exception',
  );
  const selfFunctions = report.functions.filter(
    ({ owner }) => owner === responsibilityMap.protectedBaseline.owner,
  );
  const current = {
    aggregateBaseRisk: selfFunctions.reduce(
      (sum, item) => sum + item.baseRisk,
      0,
    ),
    maxBaseRisk: Math.max(...selfFunctions.map(({ baseRisk }) => baseRisk)),
    above50: selfFunctions.filter(({ baseRisk }) => baseRisk > 50).length,
    above100: selfFunctions.filter(({ baseRisk }) => baseRisk > 100).length,
    wrapperOnlyFindings: report.findings.filter(
      ({ code, paths }) =>
        code === 'wrapper-only-extraction' &&
        paths.some((relative) =>
          relative.startsWith('framework/maintainability/'),
        ),
    ).length,
  };
  for (const metricName of [
    'aggregateBaseRisk',
    'maxBaseRisk',
    'above50',
    'above100',
  ])
    assert.ok(
      current[metricName] < responsibilityMap.protectedBaseline[metricName],
      `${metricName} must improve against the exact protected baseline`,
    );
  assert.equal(current.wrapperOnlyFindings, 0);
  assert.equal(
    responsibilityMap.frozenPublicContract.requiredGateNames,
    'unchanged',
  );
});

test('phase-2 governance hotspots stay below the exact protected baseline without risk transfer', () => {
  const exactBaseline = 'df20d7082b751cdf79072deb47bbce3f64149f1b';
  const repositoryPolicy = readJson(
    'framework/maintainability/function-risk-policy.json',
  );
  const repositoryLayers = readJson('framework/core/architecture/layers.json');
  const repositoryOwnership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const baseline = kernelFunctionSnapshot(
    trackedFilesAt(exactBaseline),
    repositoryPolicy,
    repositoryLayers,
    repositoryOwnership,
  ).functions;
  const report = buildReport({ languageFamily: 'javascript-typescript' });
  const owner = 'framework/maintainability';
  const current = report.functions.filter((item) => item.owner === owner);
  const targets = new Map([
    ['source-analysis-kernel.mjs:stripStringsAndComments', 138],
    ['source-analysis-kernel.mjs:ownerFor', 122],
    ['source-analysis-kernel.mjs:classify', 98],
    ['semantic-amplification.mjs:evaluateDetector', 76],
    ['semantic-amplification.mjs:queryTaskGraph', 75],
  ]);
  const targetFunctions = current.filter((item) =>
    targets.has(`${path.basename(item.path)}:${item.symbol}`),
  );

  assert.equal(targetFunctions.length, targets.size);
  for (const item of targetFunctions)
    assert.ok(
      item.baseRisk < targets.get(`${path.basename(item.path)}:${item.symbol}`),
      `${item.symbol} must improve against ${exactBaseline}`,
    );
  assert.ok(
    targetFunctions.reduce((sum, item) => sum + item.baseRisk, 0) <= 381,
  );
  assert.ok(current.reduce((sum, item) => sum + item.baseRisk, 0) < 2328);
  assert.ok(current.filter((item) => item.baseRisk > 50).length < 14);
  assert.equal(current.filter((item) => item.baseRisk > 100).length, 0);
  assert.ok(Math.max(...current.map((item) => item.baseRisk)) < 100);
  assert.equal(
    report.findings.filter(
      ({ code, paths }) =>
        code === 'wrapper-only-extraction' &&
        paths.some((relative) =>
          relative.startsWith('framework/maintainability/'),
        ),
    ).length,
    0,
  );

  const baselineHotspots = new Set(
    baseline
      .filter((item) => item.owner === owner && item.baseRisk > 50)
      .map((item) => `${item.path}:${item.symbol}`),
  );
  assert.ok(
    current
      .filter((item) => item.baseRisk > 50)
      .every((item) => baselineHotspots.has(`${item.path}:${item.symbol}`)),
    'no new or renamed same-owner hotspot may exceed 50',
  );
});

test('C++ view uses its exact protected-head baseline and excludes other languages', () => {
  const report = buildReport({ languageFamily: 'c-cpp' });
  assert.deepEqual(report.view, {
    kind: 'language-family',
    language: 'c-cpp',
  });
  assert.equal(report.baseline.ref, '1510515e7d61eafc3182b769efacd171ba489198');
  assert.deepEqual(Object.keys(report.summary.byLanguage), ['c-cpp']);
  assert.ok(report.functions.length > 0);
  assert.ok(report.functions.every(({ language }) => language === 'c-cpp'));
  assert.ok(
    report.retiredFunctions.every(({ language }) => language === 'c-cpp'),
  );
});
