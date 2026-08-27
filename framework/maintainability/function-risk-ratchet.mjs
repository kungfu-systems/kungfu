// SPDX-License-Identifier: Apache-2.0
// @ts-check

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  analyzeTransition,
  referencedNewFunctions,
} from './function-risk-transition.mjs';
import { buildReport } from './function-risk.mjs';
import {
  baselineChangedPaths,
  currentBytes,
  digest,
  git,
  readJson,
  readThroughAnalysisCache,
} from './source-analysis-kernel.mjs';
import {
  functionSnapshot,
  trackedCurrentPaths,
  trackedFilesAtPaths,
} from './source-analysis-session.mjs';

const PUBLIC_POLICY_PATH =
  'framework/maintainability/function-risk-policy.json';
const RATCHET_POLICY_PATH =
  'framework/maintainability/function-risk-ratchet-policy.json';

function sumRisk(functions) {
  return functions.reduce((sum, item) => sum + item.baseRisk, 0);
}

function evaluateFunctionRiskRatchet(
  current,
  baseline,
  transition,
  ratchetPolicy,
  options = {},
) {
  const baselineById = new Map(
    baseline.functions.map((item) => [item.id, item]),
  );
  const findings = [];
  for (const item of transition.functions) {
    const previous = item.previousId ? baselineById.get(item.previousId) : null;
    if (
      previous &&
      item.bodyRoot !== previous.bodyRoot &&
      item.baseRisk > previous.baseRisk
    )
      findings.push({
        code: 'changed-function-risk-increase',
        severity: 'blocking',
        owner: item.owner,
        paths: [previous.path, item.path].filter(
          (value, index, values) => values.indexOf(value) === index,
        ),
        symbol: item.symbol,
        previousBaseRisk: previous.baseRisk,
        currentBaseRisk: item.baseRisk,
        message: 'changed function baseRisk exceeds its exact protected base',
      });
    if (
      !previous &&
      item.baseRisk > ratchetPolicy.newFunctionBaseRiskEnvelope[item.language]
    )
      findings.push({
        code: 'new-function-risk-envelope-exceeded',
        severity: 'blocking',
        owner: item.owner,
        paths: [item.path],
        symbol: item.symbol,
        currentBaseRisk: item.baseRisk,
        envelope: ratchetPolicy.newFunctionBaseRiskEnvelope[item.language],
        message: 'new function exceeds its fixed language-family envelope',
      });
  }

  const currentById = new Map(
    transition.functions.map((item) => [item.id, item]),
  );
  for (const item of transition.functions) {
    const previous = item.previousId ? baselineById.get(item.previousId) : null;
    const helperIds = previous
      ? options.referencedNewIdsByPreviousId?.get(previous.id) || new Set()
      : new Set();
    const helpers = [...helperIds]
      .map((id) => currentById.get(id))
      .filter(Boolean);
    if (
      previous &&
      helpers.length &&
      item.baseRisk + sumRisk(helpers) >= previous.baseRisk
    )
      findings.push({
        code: 'wrapper-only-risk-reset',
        severity: 'blocking',
        owner: item.owner,
        paths: [
          ...new Set([item.path, ...helpers.map(({ path }) => path)]),
        ].sort(),
        previousAggregateBaseRisk: previous.baseRisk,
        currentAggregateBaseRisk: item.baseRisk + sumRisk(helpers),
        message:
          'same-owner extraction did not reduce aggregate function responsibility',
      });
  }
  for (const finding of transition.findings) {
    if (
      ![
        'ambiguous-function-identity',
        'generated-or-vendor-relabeling',
      ].includes(finding.code)
    )
      continue;
    findings.push({
      ...finding,
      severity: 'blocking',
      owner: '',
      message:
        finding.code === 'ambiguous-function-identity'
          ? finding.message
          : 'changed first-party function source cannot leave the measured surface',
    });
  }
  findings.sort((left, right) =>
    `${left.code}\0${left.owner}\0${left.paths.join('\0')}\0${left.symbol || ''}`.localeCompare(
      `${right.code}\0${right.owner}\0${right.paths.join('\0')}\0${right.symbol || ''}`,
    ),
  );
  return findings;
}

function buildFunctionRiskRatchet(options = {}) {
  const base = String(options.base || '');
  if (!/^[0-9a-f]{40}$/u.test(base))
    throw new Error(
      'function-risk ratchet requires an exact --base commit SHA',
    );
  const resolvedBase = String(git(['rev-parse', `${base}^{commit}`])).trim();
  if (resolvedBase !== base)
    throw new Error('function-risk ratchet base must resolve to itself');
  const sourceCommit = String(git(['rev-parse', 'HEAD^{commit}'])).trim();
  const sourceTree = String(git(['rev-parse', 'HEAD^{tree}'])).trim();
  const sourceStatus = String(
    git(['status', '--porcelain=v1', '--untracked-files=all']),
  );
  const changedPaths = [...baselineChangedPaths(base)].sort();
  const publicPolicy = readJson(PUBLIC_POLICY_PATH);
  const ratchetPolicy = readJson(RATCHET_POLICY_PATH);
  const layers = readJson('framework/core/architecture/layers.json');
  const ownership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const analysisOptions = {
    ...options,
    extractorAlgorithm: 'python-multiline-v2',
  };
  const identity = {
    sourceCommit,
    sourceTree,
    sourceStatusRoot: digest(Buffer.from(sourceStatus)),
    baselineRevision: base,
    policyRoot: digest({ publicPolicy, ratchetPolicy }),
    inputContractRoot: digest({ changedPaths, layers, ownership }),
    implementationRoot: digest(
      [
        'framework/maintainability/source-analysis-kernel.mjs',
        'framework/maintainability/source-analysis-session.mjs',
        'framework/maintainability/function-risk-transition.mjs',
        'framework/maintainability/function-risk-ratchet.mjs',
      ].map((path) => ({ path, root: digest(currentBytes(path)) })),
    ),
  };
  const cached = readThroughAnalysisCache(
    'function-risk-ratchet',
    identity,
    () => {
      const baselineInputs = trackedFilesAtPaths(base, changedPaths);
      const currentInputs = trackedCurrentPaths(changedPaths);
      const baseline = functionSnapshot(
        baselineInputs,
        publicPolicy,
        layers,
        ownership,
        analysisOptions,
      );
      const current = functionSnapshot(
        currentInputs,
        publicPolicy,
        layers,
        ownership,
        analysisOptions,
      );
      const transition = analyzeTransition(
        current.functions,
        baseline.functions,
        current.files,
        baseline.files,
        publicPolicy,
        {
          identityAlgorithm: 'qualified-occurrence-v2',
          movementScope: 'same-owner',
          sourceFiles: currentInputs,
        },
      );
      const baselineById = new Map(
        baseline.functions.map((item) => [item.id, item]),
      );
      return {
        baseline,
        current,
        transition,
        findings: evaluateFunctionRiskRatchet(
          current,
          baseline,
          transition,
          ratchetPolicy,
          {
            referencedNewIdsByPreviousId: referencedNewFunctions(
              currentInputs,
              transition.functions,
              baselineById,
            ),
          },
        ),
      };
    },
    { runtimeRoot: sourceStatus.trim() ? '' : undefined },
  );
  const body = {
    schema: 'kungfu.function-risk-ratchet/v1',
    status: 'required',
    verdict: cached.value.findings.length ? 'fail' : 'pass',
    sourceCommit,
    sourceTree,
    sourceState: sourceStatus.trim() ? 'working-tree' : 'exact-revision',
    baseRevision: base,
    changedPaths,
    changedPathsRoot: digest(changedPaths),
    policyPath: RATCHET_POLICY_PATH,
    policyRoot: digest(ratchetPolicy),
    cache: { hit: cached.hit, authority: 'disposable-non-authoritative' },
    summary: {
      changedPaths: changedPaths.length,
      baselineFunctions: cached.value.baseline.functions.length,
      currentFunctions: cached.value.current.functions.length,
      blockingFindings: cached.value.findings.length,
    },
    findings: cached.value.findings,
  };
  return { ...body, reportRoot: digest(body) };
}

function runFunctionRiskGate(options = {}) {
  const analysisMemo = new Map();
  let extractionCount = 0;
  const analysisOptions = {
    analysisMemo,
    onExtract: () => {
      extractionCount += 1;
    },
  };
  const fastStarted = performance.now();
  const ratchet = (options.buildRatchet || buildFunctionRiskRatchet)({
    base: options.base,
    ...analysisOptions,
  });
  const fastElapsedMs = performance.now() - fastStarted;
  const fastExtractions = extractionCount;
  if (ratchet.verdict !== 'pass')
    return {
      verdict: 'fail',
      ratchet,
      advisory: null,
      execution: {
        fastElapsedMs,
        fullElapsedMs: 0,
        fastExtractions,
        fullAdditionalExtractions: 0,
        failFast: true,
      },
    };
  const fullStarted = performance.now();
  const advisory = (options.buildAdvisory || buildReport)(analysisOptions);
  return {
    verdict: 'pass',
    ratchet,
    advisory,
    execution: {
      fastElapsedMs,
      fullElapsedMs: performance.now() - fullStarted,
      fastExtractions,
      fullAdditionalExtractions: extractionCount - fastExtractions,
      failFast: false,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? '' : argv[baseIndex + 1];
  if (baseIndex === -1 || !base)
    throw new Error('--base requires a commit SHA');
  const consumed = new Set(['--base', base, '--json']);
  const unknown = argv.filter((value) => !consumed.has(value));
  if (unknown.length) throw new Error(`unknown argument '${unknown[0]}'`);
  const report = runFunctionRiskGate({ base });
  if (argv.includes('--json'))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.verdict === 'pass')
    process.stdout.write(
      `pass: changed-code function-risk ratchet; ${report.ratchet.summary.changedPaths} changed paths, ${report.execution.fastExtractions} fast extractions, ${report.execution.fullAdditionalExtractions} additional full-path extractions; advisory ${report.advisory.reportRoot}\n`,
    );
  else {
    process.stderr.write(
      `function-risk ratchet: ${report.ratchet.summary.blockingFindings} blocking findings; full advisory skipped\n`,
    );
    for (const finding of report.ratchet.findings)
      process.stderr.write(
        `- ${finding.code}: owner=${finding.owner || 'unowned'} paths=${finding.paths.join(',')} symbol=${finding.symbol || '-'} previous=${finding.previousBaseRisk ?? finding.previousAggregateBaseRisk ?? '-'} current=${finding.currentBaseRisk ?? finding.currentAggregateBaseRisk ?? '-'} envelope=${finding.envelope ?? '-'}\n`,
      );
  }
  if (report.verdict !== 'pass') process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `function-risk gate: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export {
  buildFunctionRiskRatchet,
  evaluateFunctionRiskRatchet,
  runFunctionRiskGate,
};
