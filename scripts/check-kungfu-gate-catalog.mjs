#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGateRegistry } from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = 'docs/qualification/gates/policy-matrix.md';
const BINDINGS = 'docs/qualification/gates/workflow-bindings.json';
const BEGIN = '<!-- BEGIN GENERATED GATE MATRIX -->';
const END = '<!-- END GENERATED GATE MATRIX -->';
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

export function renderPolicyMatrix(registry) {
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
  return [...header, ...rows].join('\n');
}

function replaceGeneratedMatrix(text, matrix) {
  const start = text.indexOf(BEGIN);
  const finish = text.indexOf(END);
  if (start < 0 || finish < 0 || finish <= start) {
    throw new Error(`missing ordered matrix markers in ${MATRIX}`);
  }
  return `${text.slice(0, start + BEGIN.length)}\n${matrix}\n${text.slice(finish)}`;
}

export function checkKungfuGateCatalog(root = ROOT) {
  const issues = [];
  const registry = readJson(root, 'shifu.gates.json');
  const validation = validateGateRegistry(registry);
  for (const issue of validation) {
    issues.push(`[registry] ${issue.path}: ${issue.message}`);
  }
  if (validation.length) return { issues, registry };

  const bindingDocument = readJson(root, BINDINGS);
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
    renderPolicyMatrix(registry),
  );
  if (matrixText !== expected) {
    issues.push(`[matrix] ${MATRIX} differs from shifu.gates.json`);
  }

  if (bindingDocument.schema !== 'kungfu.gate-workflow-bindings/v1') {
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
    if (!['gate', 'controller'].includes(binding.execution)) {
      issues.push(
        `[workflow] ${binding.id}: execution must be 'gate' or 'controller'`,
      );
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
    if (
      !binding.requiredSnippets?.length ||
      binding.requiredSnippets.some(
        (snippet) => typeof snippet !== 'string' || snippet.length === 0,
      )
    ) {
      issues.push(
        `[workflow] ${binding.id}: requiredSnippets must contain non-empty strings`,
      );
    }
    if (
      binding.execution === 'gate' &&
      !binding.requiredSnippets?.some((snippet) => snippet.includes('gate run'))
    ) {
      issues.push(
        `[workflow] ${binding.id}: gate execution must prove a 'gate run' entrypoint`,
      );
    }
    const workflow = path.join(root, workflowRelative);
    if (!fs.existsSync(workflow)) {
      issues.push(`[workflow] ${binding.id}: missing ${binding.workflow}`);
      continue;
    }
    const workflowText = fs.readFileSync(workflow, 'utf8');
    for (const snippet of binding.requiredSnippets || []) {
      if (!workflowText.includes(snippet)) {
        issues.push(
          `[workflow] ${binding.id}: '${snippet}' not found in ${binding.workflow}`,
        );
      }
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
  return { issues, registry };
}

export function writePolicyMatrix(root = ROOT) {
  const registry = readJson(root, 'shifu.gates.json');
  const file = path.join(root, MATRIX);
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(
    file,
    replaceGeneratedMatrix(current, renderPolicyMatrix(registry)),
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
    `[kungfu-gates] ${result.registry.gates.length} gates, ${result.registry.profiles.length} profiles, docs/matrix/workflows aligned`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
