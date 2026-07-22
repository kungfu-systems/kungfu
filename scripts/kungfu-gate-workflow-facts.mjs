// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { controllerFactsForJob } from './kungfu-gate-controller-adapters.mjs';

const WORKFLOW_ROOT = '.github/workflows';
const GATE_PROFILE_WORKFLOW = '/.github/workflows/.gate-profile.yml@';
const GATE_COMMAND =
  /(?:^|[\n;]|&&|\|\|)\s*(\.\/shifu|\.\\shifu\.cmd)\s+gate\s+run(?:\s+("[^"]*"|'[^']*'|[^\s;&|]+))?([^\n;]*?)(?=$|\n|;|&&|\|\|)/g;

function workflowFiles(root) {
  const directory = path.join(root, WORKFLOW_ROOT);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')),
    )
    .map((entry) => `${WORKFLOW_ROOT}/${entry.name}`)
    .sort();
}

function staticToken(token) {
  if (!token) return null;
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function commandText(run) {
  return run
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/`\r?\n\s*/g, ' ');
}

function shellWords(value) {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function directGateFacts(workflow, jobId, steps, gateIds, issues) {
  const facts = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || typeof step.run !== 'string') {
      continue;
    }
    const run = commandText(step.run);
    GATE_COMMAND.lastIndex = 0;
    for (const match of run.matchAll(GATE_COMMAND)) {
      const gate = staticToken(match[2]);
      const location = `${workflow}#${jobId}.steps[${stepIndex}]`;
      if (!gate || !/^[a-z0-9][a-z0-9.-]*$/.test(gate)) {
        issues.push(
          `[workflow-fact] ${location}: Gate id must be a static catalog id`,
        );
        continue;
      }
      if (!gateIds.has(gate)) {
        issues.push(`[workflow-fact] ${location}: unknown Gate '${gate}'`);
        continue;
      }
      facts.push({
        workflow,
        job: jobId,
        execution: 'gate',
        profile: null,
        gates: [gate],
        args: shellWords(match[3] || ''),
        source: `steps[${stepIndex}].run`,
      });
    }
  }
  return facts;
}

function profileFact(workflow, jobId, job, profilesById, issues) {
  if (
    typeof job.uses !== 'string' ||
    !job.uses.includes(GATE_PROFILE_WORKFLOW)
  ) {
    return null;
  }
  const profile = job.with?.['gate-profile'];
  const location = `${workflow}#${jobId}.with.gate-profile`;
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(profile)) {
    issues.push(
      `[workflow-fact] ${location}: Gate profile must be a static catalog profile`,
    );
    return null;
  }
  const policy = profilesById.get(profile);
  if (!policy) {
    issues.push(
      `[workflow-fact] ${location}: unknown Gate profile '${profile}'`,
    );
    return null;
  }
  const gates = Object.entries(policy.decisions)
    .filter(([, decision]) => decision.mode !== 'off')
    .map(([gate]) => gate)
    .sort();
  return {
    workflow,
    job: jobId,
    execution: 'profile',
    profile,
    gates,
    source: 'uses.with.gate-profile',
    _actual: job,
  };
}

export function scanWorkflowInvocations(root, registry, bindings = []) {
  const issues = [];
  const facts = [];
  const gateIds = new Set(registry.gates.map((gate) => gate.id));
  const profilesById = new Map(
    registry.profiles.map((profile) => [profile.id, profile]),
  );
  for (const workflow of workflowFiles(root)) {
    const file = path.join(root, workflow);
    const document = parseDocument(fs.readFileSync(file, 'utf8'), {
      prettyErrors: false,
      uniqueKeys: true,
    });
    for (const error of document.errors) {
      issues.push(`[workflow-yaml] ${workflow}: ${error.message}`);
    }
    if (document.errors.length) continue;
    const value = document.toJS();
    if (!value?.jobs || typeof value.jobs !== 'object') continue;
    for (const [jobId, job] of Object.entries(value.jobs)) {
      if (!job || typeof job !== 'object') continue;
      if (Array.isArray(job.steps)) {
        facts.push(
          ...directGateFacts(workflow, jobId, job.steps, gateIds, issues),
        );
      }
      const reusable = profileFact(workflow, jobId, job, profilesById, issues);
      if (reusable) facts.push(reusable);
      facts.push(...controllerFactsForJob(workflow, jobId, job, bindings));
    }
  }
  facts.sort((left, right) =>
    [left.workflow, left.job, left.execution, left.profile || '', ...left.gates]
      .join('\0')
      .localeCompare(
        [
          right.workflow,
          right.job,
          right.execution,
          right.profile || '',
          ...right.gates,
        ].join('\0'),
      ),
  );
  return { facts, issues };
}
