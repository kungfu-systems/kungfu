// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeTransition,
  buildReport,
  digest,
  extractFunctions,
} from './function-risk.mjs';

const layers = { components: [] };
const ownership = [];
const policy = {
  includedClasses: ['first-party-handwritten-implementation'],
  antiGaming: { complexityDropForWrapperSignal: 3 },
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
    const functions = extractFunctions(
      { path: pathname, bytes: Buffer.from(source) },
      layers,
      ownership,
    );
    assert.equal(functions.length, 1, pathname);
    assert.equal(functions[0].language, family);
    assert.equal(functions[0].symbol, 'work');
    assert.ok(functions[0].cyclomatic >= 2);
    assert.match(functions[0].bodyRoot, /^sha256:[0-9a-f]{64}$/u);
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
  const result = analyzeTransition(current, baseline, [], [], policy);
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
});
