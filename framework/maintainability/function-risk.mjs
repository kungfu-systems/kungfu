#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { analyzeTransition } from './function-risk-transition.mjs';
import {
  currentBytes,
  digest,
  extractFunctions,
  languageFamily,
  readJson,
  readThroughAnalysisCache,
  git as runGit,
  stripStringsAndComments,
  trackedCurrentFiles,
  trackedFilesAt,
} from './source-analysis-kernel.mjs';
import { functionSnapshot } from './source-analysis-session.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const POLICY_PATH = 'framework/maintainability/function-risk-policy.json';

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

function findingMatchesLanguage(finding, family, functionsById) {
  return finding.paths.some((value) => {
    if (value.startsWith(`${family}:`)) return true;
    const metric = functionsById.get(value);
    if (metric) return metric.language === family;
    return family === 'c-cpp' && languageFamily(value) === family;
  });
}

function buildReport(options = {}) {
  const policy = readJson(POLICY_PATH);
  const layers = readJson('framework/core/architecture/layers.json');
  const ownership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const selectedLanguage = options.languageFamily || '';
  if (
    selectedLanguage &&
    !Object.hasOwn(policy.languageFamilies, selectedLanguage)
  )
    throw new Error(`unknown language family '${selectedLanguage}'`);
  const baselineRef =
    policy.languageBaselines?.[selectedLanguage] || policy.baselineRef;
  const baselineRevision = String(
    runGit(['rev-parse', `${baselineRef}^{commit}`]),
  ).trim();
  if (baselineRevision !== baselineRef)
    throw new Error('function-risk baselineRef must be an exact commit SHA');
  const sourceRevision = String(runGit(['rev-parse', 'HEAD^{commit}'])).trim();
  const sourceTree = String(runGit(['rev-parse', 'HEAD^{tree}'])).trim();
  const sourceStatus = String(
    runGit(['status', '--porcelain=v1', '--untracked-files=all']),
  );
  const dirty = Boolean(sourceStatus.trim());
  const identity = {
    sourceCommit: sourceRevision,
    sourceTree,
    sourceStatusRoot: digest(Buffer.from(sourceStatus)),
    baselineRevision,
    policyRoot: digest(policy),
    inputContractRoot: digest({ layers, ownership }),
    implementationRoot: digest([
      {
        path: 'framework/maintainability/source-analysis-kernel.mjs',
        root: digest(
          currentBytes('framework/maintainability/source-analysis-kernel.mjs'),
        ),
      },
      {
        path: 'framework/maintainability/source-analysis-session.mjs',
        root: digest(
          currentBytes('framework/maintainability/source-analysis-session.mjs'),
        ),
      },
      {
        path: 'framework/maintainability/function-risk.mjs',
        root: digest(
          currentBytes('framework/maintainability/function-risk.mjs'),
        ),
      },
      {
        path: 'framework/maintainability/function-risk-transition.mjs',
        root: digest(
          currentBytes(
            'framework/maintainability/function-risk-transition.mjs',
          ),
        ),
      },
    ]),
  };
  const analysis = readThroughAnalysisCache(
    'function-risk',
    identity,
    () => {
      const baseline = functionSnapshot(
        trackedFilesAt(baselineRevision),
        policy,
        layers,
        ownership,
        options,
      );
      const currentInputs = trackedCurrentFiles();
      const current = functionSnapshot(
        currentInputs,
        policy,
        layers,
        ownership,
        options,
      );
      return {
        baseline,
        current,
        transition: analyzeTransition(
          current.functions,
          baseline.functions,
          current.files,
          baseline.files,
          policy,
          {
            movementScope: 'same-owner',
            movementIdentity: 'body-root',
            sourceFiles: currentInputs,
          },
        ),
      };
    },
    { runtimeRoot: dirty ? '' : undefined },
  ).value;
  const { baseline, current, transition } = analysis;
  const selectedFunctions = selectedLanguage
    ? transition.functions.filter(
        ({ language: value }) => value === selectedLanguage,
      )
    : transition.functions;
  const selectedTransitions = selectedLanguage
    ? transition.transitions.filter(
        ({ current, previous }) =>
          current?.language === selectedLanguage ||
          previous?.language === selectedLanguage,
      )
    : transition.transitions;
  const selectedRetiredFunctions = selectedLanguage
    ? transition.retiredFunctions.filter(
        ({ language: value }) => value === selectedLanguage,
      )
    : transition.retiredFunctions;
  const functionsById = new Map(
    [...transition.functions, ...transition.retiredFunctions].map((item) => [
      item.id,
      item,
    ]),
  );
  const selectedFindings = selectedLanguage
    ? transition.findings.filter((finding) =>
        findingMatchesLanguage(finding, selectedLanguage, functionsById),
      )
    : transition.findings;
  const body = {
    schema: 'kungfu.function-risk-report/v1',
    status: 'advisory',
    enforcement: 'none',
    sourceRevision,
    sourceState: dirty ? 'working-tree' : 'exact-revision',
    sourceRoot: current.sourceRoot,
    policyPath: POLICY_PATH,
    policyRoot: digest(policy),
    view: selectedLanguage
      ? { kind: 'language-family', language: selectedLanguage }
      : { kind: 'all-language-families' },
    baseline: {
      ref: baselineRef,
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
          .filter((family) => !selectedLanguage || family === selectedLanguage)
          .sort()
          .map((family) => [
            family,
            selectedFunctions.filter(({ language: value }) => value === family)
              .length,
          ]),
      ),
      functions: selectedFunctions.length,
      findings: selectedFindings.length,
      blockingFindings: 0,
    },
    functions: selectedFunctions,
    transitions: selectedTransitions,
    retiredFunctions: selectedRetiredFunctions,
    findings: selectedFindings,
  };
  return { ...body, reportRoot: digest(body) };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const languageIndex = argv.indexOf('--language');
  const languageFamily = languageIndex === -1 ? '' : argv[languageIndex + 1];
  if (languageIndex !== -1 && !languageFamily)
    throw new Error('--language requires a language family');
  const consumed = new Set(['--json', '--check']);
  if (languageIndex !== -1) {
    consumed.add('--language');
    consumed.add(languageFamily);
  }
  const unknown = argv.filter((arg) => !consumed.has(arg));
  if (unknown.length) throw new Error(`unknown argument '${unknown[0]}'`);
  const report = buildReport({ languageFamily });
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
