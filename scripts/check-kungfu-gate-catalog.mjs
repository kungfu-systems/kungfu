#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  controllerAdapterMismatches,
  validateControllerAdapters,
} from './kungfu-gate-controller-adapters.mjs';
import { scanWorkflowInvocations } from './kungfu-gate-workflow-facts.mjs';
import {
  gateDefinitionDigest,
  gateDigest,
  validateGateRegistry,
} from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = 'docs/qualification/gates/policy-matrix.md';
const BINDINGS = 'docs/qualification/gates/workflow-bindings.json';
const EXECUTION_PROFILES = 'docs/qualification/gates/execution-profiles.json';
const MEASUREMENT_COVERAGE =
  'docs/qualification/gates/measurement-coverage.json';
const MEASUREMENT_REPORT = 'docs/qualification/gates/measurement-coverage.md';
const MEASUREMENT_BASELINE_DIGEST =
  'sha256:2fc06a1263119544e4130724390f737016797de7c5df0a17cbf10ab23c024fb9';
const BEGIN = '<!-- BEGIN GENERATED GATE MATRIX -->';
const END = '<!-- END GENERATED GATE MATRIX -->';
const MEASUREMENT_BEGIN = '<!-- BEGIN GENERATED GATE MEASUREMENTS -->';
const MEASUREMENT_END = '<!-- END GENERATED GATE MEASUREMENTS -->';
const REQUIRED_DOC_FIELDS = [
  'Problem',
  'Protects',
  'Action',
  'Dependencies',
  'Platforms and runner',
  'Pass',
  'Failure or skip',
  'Evidence',
  'Diagnosis',
  'Cost',
  'Current source',
  'Retirement',
];

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function exactObjectKeys(value, required, prefix, issues) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`[measurement] ${prefix} must be an object`);
    return false;
  }
  const allowed = new Set(required);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      issues.push(`[measurement] ${prefix}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      issues.push(`[measurement] ${prefix}.${key} is not allowed`);
  }
  return true;
}

function safeEvidencePath(relative) {
  return (
    typeof relative === 'string' &&
    relative.startsWith('docs/qualification/evidence/') &&
    relative.endsWith('.json') &&
    !path.isAbsolute(relative) &&
    !relative.split('/').includes('..')
  );
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === new Set(actual).size &&
    [...actual].sort().join('\0') === [...expected].sort().join('\0')
  );
}

export function validateMeasurementCoverage(root, registry) {
  const issues = [];
  const document = readJson(root, MEASUREMENT_COVERAGE);
  exactObjectKeys(
    document,
    ['schema', 'registry', 'baseline', 'measurements'],
    'document',
    issues,
  );
  if (document.schema !== 'kungfu.gate-measurement-coverage/v1')
    issues.push('[measurement] unsupported schema');
  if (document.registry !== 'shifu.gates.json')
    issues.push('[measurement] registry must be shifu.gates.json');

  const baseline = document.baseline;
  if (
    exactObjectKeys(
      baseline,
      ['adoptedAt', 'unmeasuredGateIds', 'digest'],
      'baseline',
      issues,
    )
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(baseline.adoptedAt || ''))
      issues.push('[measurement] baseline.adoptedAt must be YYYY-MM-DD');
    if (
      !Array.isArray(baseline.unmeasuredGateIds) ||
      baseline.unmeasuredGateIds.some(
        (gateId) => typeof gateId !== 'string' || !gateId,
      ) ||
      baseline.unmeasuredGateIds.length !==
        new Set(baseline.unmeasuredGateIds).size ||
      baseline.unmeasuredGateIds.join('\0') !==
        [...baseline.unmeasuredGateIds].sort().join('\0')
    ) {
      issues.push(
        '[measurement] baseline.unmeasuredGateIds must be unique and sorted',
      );
    }
    const actualDigest = gateDigest(
      Array.isArray(baseline.unmeasuredGateIds)
        ? baseline.unmeasuredGateIds
        : [],
    );
    if (baseline.digest !== actualDigest)
      issues.push('[measurement] baseline.digest does not match its Gate ids');
    if (actualDigest !== MEASUREMENT_BASELINE_DIGEST)
      issues.push(
        '[measurement] frozen unmeasured baseline changed; new Gates must add measurements',
      );
  }

  const gates = new Map(registry.gates.map((gate) => [gate.id, gate]));
  const exempt = new Set(
    Array.isArray(baseline?.unmeasuredGateIds)
      ? baseline.unmeasuredGateIds
      : [],
  );
  const records = new Map();
  if (!Array.isArray(document.measurements)) {
    issues.push('[measurement] document.measurements must be an array');
  }
  for (const [recordIndex, record] of (Array.isArray(document.measurements)
    ? document.measurements
    : []
  ).entries()) {
    const at = `measurements[${recordIndex}]`;
    if (
      !exactObjectKeys(
        record,
        ['gateId', 'definitionDigest', 'observations'],
        at,
        issues,
      )
    )
      continue;
    if (records.has(record.gateId))
      issues.push(`[measurement] duplicate Gate record '${record.gateId}'`);
    records.set(record.gateId, record);
    const gate = gates.get(record.gateId);
    if (!gate) {
      issues.push(`[measurement] unknown Gate '${record.gateId}'`);
      continue;
    }
    const currentDefinitionDigest = gateDefinitionDigest(gate);
    if (record.definitionDigest !== currentDefinitionDigest)
      issues.push(`[measurement] ${record.gateId}: definition digest is stale`);
    if (!Array.isArray(record.observations) || !record.observations.length) {
      issues.push(
        `[measurement] ${record.gateId}: observations must be a non-empty array`,
      );
      continue;
    }
    const observedPlatforms = record.observations.map(
      (observation) => observation?.platform,
    );
    if (!sameStringSet(observedPlatforms, gate.platforms))
      issues.push(
        `[measurement] ${record.gateId}: measured platforms [${observedPlatforms.join(', ')}], expected [${gate.platforms.join(', ')}]`,
      );
    const sourceShas = new Set(
      record.observations.map((observation) => observation?.sourceSha),
    );
    const registryDigests = new Set(
      record.observations.map((observation) => observation?.registryDigest),
    );
    if (sourceShas.size !== 1 || registryDigests.size !== 1)
      issues.push(
        `[measurement] ${record.gateId}: all platforms must measure one source and registry revision`,
      );
    for (const [
      observationIndex,
      observation,
    ] of record.observations.entries()) {
      const observationAt = `${at}.observations[${observationIndex}]`;
      if (
        !exactObjectKeys(
          observation,
          ['platform', 'sourceSha', 'registryDigest', 'durationMs', 'receipt'],
          observationAt,
          issues,
        )
      )
        continue;
      if (!gate.platforms.includes(observation.platform))
        issues.push(
          `[measurement] ${record.gateId}: unsupported platform '${observation.platform}'`,
        );
      if (!/^[0-9a-f]{40}$/.test(observation.sourceSha || ''))
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: sourceSha must be a full Git SHA`,
        );
      if (!/^sha256:[0-9a-f]{64}$/.test(observation.registryDigest || ''))
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: registryDigest must be sha256`,
        );
      if (
        !Number.isInteger(observation.durationMs) ||
        observation.durationMs < 0
      )
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: durationMs must be a non-negative integer`,
        );
      if (!safeEvidencePath(observation.receipt)) {
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: unsafe receipt path`,
        );
        continue;
      }
      const receiptPath = path.join(root, observation.receipt);
      if (!fs.existsSync(receiptPath)) {
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: missing ${observation.receipt}`,
        );
        continue;
      }
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      } catch {
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt is not valid JSON`,
        );
        continue;
      }
      if (receipt.schema !== 'shifu.gate-receipt/v1')
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: unsupported receipt schema`,
        );
      if (
        receipt.source?.dirty !== false ||
        receipt.source?.sha !== observation.sourceSha
      )
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt must match a clean source SHA`,
        );
      if (
        receipt.registry?.ref !== 'shifu.gates.json' ||
        receipt.registry?.projectId !== registry.project.id ||
        receipt.registry?.digest !== observation.registryDigest
      )
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt registry identity does not match`,
        );
      if (receipt.environment?.platform !== observation.platform)
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt platform does not match`,
        );
      const results = Array.isArray(receipt.results)
        ? receipt.results.filter((result) => result.gateId === record.gateId)
        : [];
      if (results.length !== 1) {
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt must contain exactly one matching result`,
        );
        continue;
      }
      const result = results[0];
      if (result.definitionDigest !== currentDefinitionDigest)
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt definition digest is stale`,
        );
      if (
        result.attempted !== true ||
        result.status !== 'pass' ||
        result.exitCode !== 0
      )
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: receipt result must be an attempted pass`,
        );
      if (result.durationMs !== observation.durationMs)
        issues.push(
          `[measurement] ${record.gateId}:${observation.platform}: durationMs differs from the receipt`,
        );
    }
  }
  for (const gate of registry.gates) {
    if (!exempt.has(gate.id) && !records.has(gate.id))
      issues.push(
        `[measurement] ${gate.id}: measurement record is required for every Gate outside the frozen baseline`,
      );
  }
  return { issues, document };
}

export function renderMeasurementCoverage(registry, document) {
  const records = new Map(
    (document.measurements || []).map((record) => [record.gateId, record]),
  );
  const baseline = new Set(document.baseline?.unmeasuredGateIds || []);
  const rows = registry.gates.map((gate) => {
    const record = records.get(gate.id);
    if (!record)
      return `| \`${gate.id}\` | ${baseline.has(gate.id) ? 'adoption baseline' : 'missing'} | — |`;
    const observations = record.observations
      .map((observation) => {
        const href = path.posix.relative(
          'docs/qualification/gates',
          observation.receipt,
        );
        return `[${observation.platform}: ${observation.durationMs} ms @ ${observation.sourceSha.slice(0, 9)}](${href})`;
      })
      .join('<br>');
    return `| \`${gate.id}\` | measured | ${observations} |`;
  });
  return [
    '| Gate | Coverage | Source-bound observations |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function objectFieldDrift(actual, expected, prefix) {
  const drift = [];
  for (const [key, value] of Object.entries(expected || {})) {
    if (!isDeepStrictEqual(actual?.[key], value))
      drift.push(`${prefix}.${key}`);
  }
  return drift;
}

function invocationDrift(fact, binding) {
  const invocation = binding.invocation || {};
  if (fact.execution === 'gate') {
    return isDeepStrictEqual(fact.args, invocation.args || []) ? [] : ['args'];
  }
  if (fact.execution === 'profile') {
    const drift = [];
    if (fact._actual?.uses !== invocation.uses) drift.push('uses');
    drift.push(
      ...objectFieldDrift(fact._actual?.with, invocation.with, 'with'),
    );
    return drift;
  }
  return [];
}

function gateActionLine(gate) {
  if (gate.action.kind === 'task') {
    const command = [gate.action.task, ...(gate.action.args || [])].join(' ');
    return `- **Action:** \`./shifu ${command}\``;
  }
  return `- **Action:** named handler \`${gate.action.handler}\`; execution requires the declared remote controller capability.`;
}

function gateDependenciesLine(gate) {
  if (!gate.dependencies.length) return '- **Dependencies:** none.';
  return `- **Dependencies:** ${gate.dependencies.map((item) => `\`${item}\``).join(', ')}.`;
}

function gatePlatformsLine(gate) {
  const capabilities = gate.runner.capabilities
    .map((item) => `\`${item}\``)
    .join(', ');
  return `- **Platforms and runner:** ${gate.platforms.join(', ')}; capabilities ${capabilities}.`;
}

function gateCurrentSourceLine(gate, bindings) {
  const sources = bindings
    .filter((binding) => binding.gates?.includes(gate.id))
    .map(
      (binding) =>
        `${binding.workflow} (${binding.job}; ${binding.activation})`,
    );
  const current = sources.length
    ? sources.join('; ')
    : 'independent Shifu task; not selected by a current remote profile.';
  return `- **Current source:** ${current}`;
}

export function renderPolicyMatrix(registry, executionDocument) {
  const profiles = registry.profiles;
  const header = [
    `| Gate | Cost | ${profiles.map((profile) => profile.id).join(' | ')} |`,
    `| --- | --- | ${profiles.map(() => ':---:').join(' | ')} |`,
  ];
  const rows = registry.gates.map((gate) => {
    const href = `${gate.documentation.replace('docs/qualification/gates/', '')}#${gate.id.replaceAll('.', '-')}`;
    const modes = profiles.map(
      (profile) => profile.decisions[gate.id]?.mode || 'missing',
    );
    return `| [\`${gate.id}\`](${href}) | ${gate.cost.class} | ${modes.join(' | ')} |`;
  });
  const executionRows = Object.entries(executionDocument.profiles).map(
    ([id, profile]) =>
      `| \`${id}\` | ${profile.budgetSeconds} | ${profile.upstreamBudgetSeconds} | ${profile.reserveSeconds} | \`${profile.episodeProfile}\` | ${profile.episodeTimeoutSeconds} | ${profile.fuzzSecondsPerTarget} |`,
  );
  return [
    ...header,
    ...rows,
    '',
    '## Execution parameters (separate from Gate selection)',
    '',
    '| Execution profile | Budget (s) | Upstream build (s) | Reserve (s) | Episode profile | Episode ceiling (s) | Fuzz seconds/target |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: |',
    ...executionRows,
    '',
    `Evidence reuse: producer \`${executionDocument.reusePolicy.producer}\`; consumer \`${executionDocument.reusePolicy.consumer}\`; mismatch \`${executionDocument.reusePolicy.mismatch}\`. Reuse key: ${executionDocument.reusePolicy.keyFields.map((field) => `\`${field}\``).join(', ')}.`,
  ].join('\n');
}

function validateExecutionProfiles(root, bindingDocument) {
  const issues = [];
  if (bindingDocument.executionProfiles !== EXECUTION_PROFILES)
    issues.push(
      `[execution-profile] workflow bindings must reference ${EXECUTION_PROFILES}`,
    );
  const document = readJson(root, EXECUTION_PROFILES);
  if (document.schema !== 'kungfu.qualification-execution-profiles/v1')
    issues.push('[execution-profile] unsupported schema');
  for (const [id, profile] of Object.entries(document.profiles || {})) {
    for (const field of [
      'budgetSeconds',
      'upstreamBudgetSeconds',
      'reserveSeconds',
      'fuzzSecondsPerTarget',
      'episodeTimeoutSeconds',
    ])
      if (!Number.isInteger(profile[field]) || profile[field] <= 0)
        issues.push(
          `[execution-profile] ${id}.${field} must be a positive integer`,
        );
    if (
      profile.reserveSeconds + profile.upstreamBudgetSeconds >=
      profile.budgetSeconds
    )
      issues.push(
        `[execution-profile] ${id}.reserveSeconds plus upstreamBudgetSeconds must be below budgetSeconds`,
      );
    const episodePath = path.join(
      root,
      'framework/core/tests/qualification/episode/profiles',
      `${profile.episodeProfile}.json`,
    );
    if (!fs.existsSync(episodePath))
      issues.push(`[execution-profile] ${id}.episodeProfile does not exist`);
    else {
      const episode = JSON.parse(fs.readFileSync(episodePath, 'utf8'));
      if (episode.name !== profile.episodeProfile)
        issues.push(`[execution-profile] ${id}.episodeProfile name drift`);
      if (episode.scenario_timeout_seconds !== profile.episodeTimeoutSeconds)
        issues.push(
          `[execution-profile] ${id}.episodeTimeoutSeconds differs from the Episode profile`,
        );
      if (
        !Array.isArray(episode.semantic?.required_dimensions) ||
        episode.semantic.required_dimensions.length === 0
      )
        issues.push(
          `[execution-profile] ${id}.episodeProfile has no deterministic semantic dimensions`,
        );
    }
  }
  const required = ['alpha', 'release-candidate', 'full-patrol'];
  for (const id of required)
    if (!document.profiles?.[id])
      issues.push(`[execution-profile] missing required profile '${id}'`);
  const keyFields = document.reusePolicy?.keyFields;
  if (!Array.isArray(keyFields) || new Set(keyFields).size !== 6)
    issues.push(
      '[execution-profile] reusePolicy.keyFields must contain six unique tuple fields',
    );
  return { issues, document };
}

function replaceGeneratedMatrix(text, matrix) {
  const start = text.indexOf(BEGIN);
  const finish = text.indexOf(END);
  if (start < 0 || finish < 0 || finish <= start) {
    throw new Error(`missing ordered matrix markers in ${MATRIX}`);
  }
  return `${text.slice(0, start + BEGIN.length)}\n${matrix}\n${text.slice(finish)}`;
}

function replaceGeneratedMeasurements(text, measurements) {
  const start = text.indexOf(MEASUREMENT_BEGIN);
  const finish = text.indexOf(MEASUREMENT_END);
  if (start < 0 || finish < 0 || finish <= start) {
    throw new Error(
      `missing ordered measurement markers in ${MEASUREMENT_REPORT}`,
    );
  }
  return `${text.slice(0, start + MEASUREMENT_BEGIN.length)}\n${measurements}\n${text.slice(finish)}`;
}

export function checkKungfuGateCatalog(root = ROOT) {
  const issues = [];
  const registry = readJson(root, 'shifu.gates.json');
  const validation = validateGateRegistry(registry);
  for (const issue of validation) {
    issues.push(`[registry] ${issue.path}: ${issue.message}`);
  }
  if (validation.length) return { issues, registry };

  const measurementValidation = validateMeasurementCoverage(root, registry);
  issues.push(...measurementValidation.issues);
  if (!measurementValidation.issues.length) {
    const measurementReportPath = path.join(root, MEASUREMENT_REPORT);
    const measurementReportText = fs.readFileSync(
      measurementReportPath,
      'utf8',
    );
    const expectedMeasurementReport = replaceGeneratedMeasurements(
      measurementReportText,
      renderMeasurementCoverage(registry, measurementValidation.document),
    );
    if (measurementReportText !== expectedMeasurementReport)
      issues.push(
        `[measurement] ${MEASUREMENT_REPORT} differs from registered measurements`,
      );
  }

  const bindingDocument = readJson(root, BINDINGS);
  const executionValidation = validateExecutionProfiles(root, bindingDocument);
  issues.push(...executionValidation.issues);
  const bindings = bindingDocument.bindings || [];
  const packageScripts = readJson(root, 'package.json').scripts || {};
  for (const gate of registry.gates) {
    if (gate.action.kind === 'task' && !packageScripts[gate.action.task]) {
      issues.push(
        `[action] ${gate.id}: package task '${gate.action.task}' does not exist`,
      );
    }
    const document = gate.documentation;
    const anchor = gate.id.replaceAll('.', '-');
    if (
      !document.startsWith('docs/') ||
      path.isAbsolute(document) ||
      document.split('/').includes('..')
    ) {
      issues.push(`[doc] ${gate.id}: unsafe documentation path`);
      continue;
    }
    const absolute = path.join(root, document);
    if (!fs.existsSync(absolute)) {
      issues.push(`[doc] ${gate.id}: missing ${document}`);
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    const open = `<!-- gate-doc:${gate.id} -->`;
    const close = `<!-- /gate-doc:${gate.id} -->`;
    const start = text.indexOf(open);
    const finish = text.indexOf(close);
    const anchorMarkup = `<a id="${anchor}"></a>`;
    if (!text.includes(anchorMarkup)) {
      issues.push(`[doc] ${gate.id}: missing declared anchor '${anchor}'`);
    } else if (text.indexOf(anchorMarkup) !== text.lastIndexOf(anchorMarkup)) {
      issues.push(`[doc] ${gate.id}: duplicate declared anchor '${anchor}'`);
    }
    if (start < 0 || finish < 0 || finish <= start) {
      issues.push(`[doc] ${gate.id}: missing ordered gate-doc markers`);
      continue;
    }
    if (
      start !== text.lastIndexOf(open) ||
      finish !== text.lastIndexOf(close)
    ) {
      issues.push(`[doc] ${gate.id}: duplicate gate-doc markers`);
    }
    const block = text.slice(start, finish);
    for (const field of REQUIRED_DOC_FIELDS) {
      if (!block.includes(`- **${field}:**`)) {
        issues.push(`[doc] ${gate.id}: missing '${field}' field`);
      }
    }
    const expectedFacts = [
      `- **Problem:** ${gate.summary}`,
      gateActionLine(gate),
      gateDependenciesLine(gate),
      gatePlatformsLine(gate),
      `- **Cost:** ${gate.cost.class}; timeout ${gate.cost.timeoutSeconds} seconds.`,
      gateCurrentSourceLine(gate, bindings),
    ];
    for (const fact of expectedFacts) {
      if (!block.includes(fact)) {
        issues.push(`[doc-fact] ${gate.id}: expected '${fact}'`);
      }
    }
  }

  const matrixPath = path.join(root, MATRIX);
  const matrixText = fs.readFileSync(matrixPath, 'utf8');
  const expected = replaceGeneratedMatrix(
    matrixText,
    renderPolicyMatrix(registry, executionValidation.document),
  );
  if (matrixText !== expected) {
    issues.push(`[matrix] ${MATRIX} differs from shifu.gates.json`);
  }

  if (bindingDocument.schema !== 'kungfu.gate-workflow-bindings/v2') {
    issues.push('[workflow] unsupported binding schema');
  }
  if (bindingDocument.registry !== 'shifu.gates.json') {
    issues.push('[workflow] binding registry must be shifu.gates.json');
  }
  const gateIds = new Set(registry.gates.map((gate) => gate.id));
  const profileIds = new Set(registry.profiles.map((profile) => profile.id));
  const covered = new Set();
  const bindingIds = new Set();
  for (const binding of bindings) {
    if (bindingIds.has(binding.id)) {
      issues.push(`[workflow] duplicate binding id '${binding.id}'`);
    }
    bindingIds.add(binding.id);
    if (!binding.job || !binding.activation) {
      issues.push(`[workflow] ${binding.id}: job and activation are required`);
    }
    if (Object.hasOwn(binding, 'requiredSnippets')) {
      issues.push(
        `[workflow] ${binding.id}: requiredSnippets is not an execution proof in schema v2`,
      );
    }
    if (!['gate', 'profile', 'controller'].includes(binding.execution)) {
      issues.push(
        `[workflow] ${binding.id}: execution must be 'gate', 'profile', or 'controller'`,
      );
    }
    if (binding.execution === 'gate') {
      if (
        !binding.invocation ||
        !Array.isArray(binding.invocation.args) ||
        binding.invocation.args.some((item) => typeof item !== 'string')
      ) {
        issues.push(
          `[workflow] ${binding.id}: gate invocation.args must be a string array`,
        );
      }
    }
    if (binding.execution === 'profile') {
      if (
        typeof binding.invocation?.uses !== 'string' ||
        binding.invocation.uses.includes('${{') ||
        !binding.invocation?.with ||
        typeof binding.invocation.with !== 'object' ||
        Array.isArray(binding.invocation.with)
      ) {
        issues.push(
          `[workflow] ${binding.id}: profile invocation requires static uses and with object`,
        );
      }
    }
    if (!binding.profiles?.length || !binding.gates?.length) {
      issues.push(
        `[workflow] ${binding.id}: profiles and gates must be non-empty`,
      );
    }
    for (const profile of binding.profiles || []) {
      if (!profileIds.has(profile)) {
        issues.push(`[workflow] ${binding.id}: unknown profile '${profile}'`);
      }
      const profilePolicy = registry.profiles.find(
        (item) => item.id === profile,
      );
      for (const gate of binding.gates || []) {
        covered.add(`${profile}:${gate}`);
        if (profilePolicy?.decisions[gate]?.mode === 'off') {
          issues.push(
            `[workflow] ${binding.id}: ${profile}:${gate} is bound but policy is off`,
          );
        }
      }
    }
    for (const gate of binding.gates || []) {
      if (!gateIds.has(gate)) {
        issues.push(`[workflow] ${binding.id}: unknown gate '${gate}'`);
      }
    }
    const workflowRelative = binding.workflow || '';
    if (
      !workflowRelative.startsWith('.github/workflows/') ||
      path.isAbsolute(workflowRelative) ||
      workflowRelative.split('/').includes('..') ||
      !/\.ya?ml$/.test(workflowRelative)
    ) {
      issues.push(`[workflow] ${binding.id}: unsafe workflow path`);
      continue;
    }
    const workflow = path.join(root, workflowRelative);
    if (!fs.existsSync(workflow)) {
      issues.push(`[workflow] ${binding.id}: missing ${binding.workflow}`);
    }
  }

  issues.push(...validateControllerAdapters(bindings));
  const workflowScan = scanWorkflowInvocations(root, registry, bindings);
  issues.push(...workflowScan.issues);
  const structuredBindings = bindings.filter((binding) =>
    ['gate', 'profile', 'controller'].includes(binding.execution),
  );
  const factsByBinding = new Map(
    structuredBindings.map((binding) => [binding.id, []]),
  );
  for (const fact of workflowScan.facts) {
    const locationBindings = structuredBindings.filter(
      (binding) =>
        binding.workflow === fact.workflow &&
        binding.job === fact.job &&
        binding.execution === fact.execution,
    );
    const matches = locationBindings.filter((binding) => {
      if (fact.execution === 'gate') {
        return (
          binding.gates?.includes(fact.gates[0]) &&
          invocationDrift(fact, binding).length === 0
        );
      }
      if (fact.execution === 'controller') {
        return controllerAdapterMismatches(fact, binding).length === 0;
      }
      return (
        binding.profiles?.length === 1 &&
        binding.profiles[0] === fact.profile &&
        [...(binding.gates || [])].sort().join('\0') ===
          fact.gates.join('\0') &&
        invocationDrift(fact, binding).length === 0
      );
    });
    const invocation =
      fact.profile ||
      fact.gates[0] ||
      `${fact.controller?.kind}:${fact.controller?.identity}`;
    const label = `${fact.workflow}#${fact.job}:${invocation}`;
    if (matches.length === 0) {
      if (fact.execution === 'gate' || fact.execution === 'profile') {
        for (const binding of locationBindings) {
          const drift = invocationDrift(fact, binding);
          if (drift.length) {
            issues.push(
              `[workflow-${fact.execution}] ${binding.id}: invocation drift at ${drift.join(', ')}`,
            );
          }
        }
      }
      if (fact.execution === 'controller') {
        for (const binding of locationBindings) {
          const drift = controllerAdapterMismatches(fact, binding);
          if (drift.length) {
            issues.push(
              `[workflow-controller] ${binding.id}: adapter input drift at ${drift.join(', ')}`,
            );
          }
        }
      }
      issues.push(
        `[workflow-fact] ${label}: invocation has no matching binding`,
      );
    } else if (matches.length > 1) {
      issues.push(
        `[workflow-fact] ${label}: invocation matches multiple bindings (${matches.map((binding) => binding.id).join(', ')})`,
      );
    } else {
      if (fact.execution === 'controller') {
        fact.gates = [...(matches[0].gates || [])].sort();
      }
      factsByBinding.get(matches[0].id).push(fact);
    }
  }
  for (const binding of structuredBindings) {
    const facts = factsByBinding.get(binding.id) || [];
    if (!facts.length) {
      issues.push(
        `[workflow-fact] ${binding.id}: no structured ${binding.execution} invocation in ${binding.workflow}#${binding.job}`,
      );
      continue;
    }
    if (binding.execution === 'gate') {
      const actual = [...new Set(facts.flatMap((fact) => fact.gates))].sort();
      const dependencyIds = new Set();
      const collectDependencies = (gateId) => {
        const gate = registry.gates.find((item) => item.id === gateId);
        for (const dependency of gate?.dependencies || []) {
          if (dependencyIds.has(dependency)) continue;
          dependencyIds.add(dependency);
          collectDependencies(dependency);
        }
      };
      for (const gate of binding.gates || []) collectDependencies(gate);
      const expected = (binding.gates || [])
        .filter((gate) => !dependencyIds.has(gate))
        .sort();
      if (actual.join('\0') !== expected.join('\0')) {
        issues.push(
          `[workflow-fact] ${binding.id}: direct Gate entries are [${actual.join(', ')}], expected [${expected.join(', ')}]`,
        );
      }
    } else if (binding.execution === 'controller' && facts.length !== 1) {
      issues.push(
        `[workflow-controller] ${binding.id}: expected one controller invocation, found ${facts.length}`,
      );
    }
  }
  for (const profile of registry.profiles) {
    for (const [gate, decision] of Object.entries(profile.decisions)) {
      if (decision.mode !== 'off' && !covered.has(`${profile.id}:${gate}`)) {
        issues.push(
          `[coverage] ${profile.id}:${gate} is ${decision.mode} without a workflow binding`,
        );
      }
    }
  }
  return { issues, registry, workflowFacts: workflowScan.facts };
}

export function writePolicyMatrix(root = ROOT) {
  const registry = readJson(root, 'shifu.gates.json');
  const executionDocument = readJson(root, EXECUTION_PROFILES);
  const measurementDocument = readJson(root, MEASUREMENT_COVERAGE);
  const file = path.join(root, MATRIX);
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(
    file,
    replaceGeneratedMatrix(
      current,
      renderPolicyMatrix(registry, executionDocument),
    ),
  );
  const measurementFile = path.join(root, MEASUREMENT_REPORT);
  const currentMeasurements = fs.readFileSync(measurementFile, 'utf8');
  fs.writeFileSync(
    measurementFile,
    replaceGeneratedMeasurements(
      currentMeasurements,
      renderMeasurementCoverage(registry, measurementDocument),
    ),
  );
}

function main() {
  if (process.argv.includes('--write')) writePolicyMatrix();
  const result = checkKungfuGateCatalog();
  if (result.issues.length) {
    console.error('[kungfu-gates] catalog violations:');
    for (const issue of result.issues) console.error(`  ${issue}`);
    process.exit(1);
  }
  console.log(
    `[kungfu-gates] ${result.registry.gates.length} gates, ${result.registry.profiles.length} profiles, ${result.workflowFacts.length} structured workflow invocations and measurement coverage aligned`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
