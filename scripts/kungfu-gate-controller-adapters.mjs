// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { isDeepStrictEqual } from 'node:util';

const COMMON_FIELDS = new Set(['type', 'kind']);
const KIND_FIELDS = {
  'job-uses': new Set(['uses', 'job', 'with']),
  'step-uses': new Set(['uses', 'name', 'with']),
  'run-step': new Set(['name', 'env', 'runContains']),
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function controllerAdapterIdentity(adapter) {
  if (!isObject(adapter) || !KIND_FIELDS[adapter.kind]) return null;
  const value = adapter.kind === 'run-step' ? adapter.name : adapter.uses;
  return typeof value === 'string' && value
    ? `${adapter.kind}\0${value}`
    : null;
}

export function validateControllerAdapters(bindings) {
  const issues = [];
  const types = new Set();
  for (const binding of bindings.filter(
    (item) => item.execution === 'controller',
  )) {
    const adapter = binding.adapter;
    const prefix = `[workflow-adapter] ${binding.id}`;
    if (!isObject(adapter)) {
      issues.push(`${prefix}: adapter object is required`);
      continue;
    }
    if (
      typeof adapter.type !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(adapter.type)
    ) {
      issues.push(`${prefix}: adapter.type must be a static id`);
    } else if (types.has(adapter.type)) {
      issues.push(`${prefix}: duplicate adapter type '${adapter.type}'`);
    } else {
      types.add(adapter.type);
    }
    const fields = KIND_FIELDS[adapter.kind];
    if (!fields) {
      issues.push(`${prefix}: unsupported adapter kind '${adapter.kind}'`);
      continue;
    }
    for (const field of Object.keys(adapter)) {
      if (!COMMON_FIELDS.has(field) && !fields.has(field)) {
        issues.push(`${prefix}: unsupported adapter field '${field}'`);
      }
    }
    const identity = controllerAdapterIdentity(adapter);
    if (!identity || identity.includes('${{')) {
      issues.push(`${prefix}: adapter identity must be static`);
    }
    if (adapter.job !== undefined && !isObject(adapter.job)) {
      issues.push(`${prefix}: adapter.job must be an object`);
    }
    if (adapter.with !== undefined && !isObject(adapter.with)) {
      issues.push(`${prefix}: adapter.with must be an object`);
    }
    if (
      adapter.kind === 'run-step' &&
      (!isObject(adapter.env) || !Object.keys(adapter.env).length)
    ) {
      issues.push(`${prefix}: run-step env must be a non-empty object`);
    }
    if (
      adapter.kind === 'run-step' &&
      (!Array.isArray(adapter.runContains) || !adapter.runContains.length)
    ) {
      issues.push(`${prefix}: run-step runContains must be non-empty`);
    }
    for (const [field, values] of [['runContains', adapter.runContains]]) {
      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          values.some((value) => typeof value !== 'string' || !value))
      ) {
        issues.push(`${prefix}: ${field} must contain non-empty strings`);
      }
    }
  }
  return issues;
}

function uniqueIdentities(bindings) {
  const identities = new Map();
  for (const binding of bindings) {
    if (binding.execution !== 'controller') continue;
    const identity = controllerAdapterIdentity(binding.adapter);
    if (!identity || identities.has(identity)) continue;
    identities.set(identity, binding.adapter);
  }
  return [...identities.values()];
}

const BUILDCHAIN_BUILD_WORKFLOW =
  /^kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@\S+$/u;

function controllerFact(workflow, job, source, adapter, actual, jobNode) {
  return {
    workflow,
    job,
    execution: 'controller',
    profile: null,
    gates: [],
    source,
    controller: {
      kind: adapter.kind,
      identity: adapter.kind === 'run-step' ? adapter.name : adapter.uses,
    },
    _actual: actual,
    _job: jobNode,
  };
}

export function controllerFactsForJob(workflow, jobId, job, bindings) {
  const facts = [];
  const adapters = uniqueIdentities(bindings);
  const governedBuildWorkflow = bindings.some(
    (binding) =>
      binding.execution === 'controller' &&
      binding.workflow === workflow &&
      binding.adapter?.kind === 'job-uses' &&
      BUILDCHAIN_BUILD_WORKFLOW.test(binding.adapter.uses),
  );
  if (
    governedBuildWorkflow &&
    typeof job.uses === 'string' &&
    BUILDCHAIN_BUILD_WORKFLOW.test(job.uses) &&
    !adapters.some(
      (adapter) => adapter.kind === 'job-uses' && adapter.uses === job.uses,
    )
  ) {
    facts.push(
      controllerFact(
        workflow,
        jobId,
        'uses',
        { kind: 'job-uses', uses: job.uses },
        job,
        job,
      ),
    );
  }
  for (const adapter of adapters) {
    if (adapter.kind === 'job-uses' && job.uses === adapter.uses) {
      facts.push(controllerFact(workflow, jobId, 'uses', adapter, job, job));
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [stepIndex, step] of steps.entries()) {
      if (!step || typeof step !== 'object') continue;
      if (adapter.kind === 'step-uses' && step.uses === adapter.uses) {
        facts.push(
          controllerFact(
            workflow,
            jobId,
            `steps[${stepIndex}].uses`,
            adapter,
            step,
            job,
          ),
        );
      }
      if (
        adapter.kind === 'run-step' &&
        step.name === adapter.name &&
        typeof step.run === 'string'
      ) {
        facts.push(
          controllerFact(
            workflow,
            jobId,
            `steps[${stepIndex}].run`,
            adapter,
            step,
            job,
          ),
        );
      }
    }
  }
  return facts;
}

function objectMismatches(actual, expected, prefix) {
  const issues = [];
  for (const [key, value] of Object.entries(expected || {})) {
    if (!isDeepStrictEqual(actual?.[key], value)) {
      issues.push(`${prefix}.${key}`);
    }
  }
  return issues;
}

export function controllerAdapterMismatches(fact, binding) {
  const adapter = binding.adapter || {};
  const identity = controllerAdapterIdentity(adapter);
  if (!identity) return ['adapter identity'];
  const factIdentity = `${fact.controller?.kind}\0${fact.controller?.identity}`;
  if (factIdentity !== identity) return ['adapter identity'];
  const issues = [];
  if (adapter.kind === 'job-uses') {
    issues.push(...objectMismatches(fact._actual, adapter.job, 'job'));
    issues.push(...objectMismatches(fact._actual?.with, adapter.with, 'with'));
  } else if (adapter.kind === 'step-uses') {
    if (adapter.name !== undefined && fact._actual?.name !== adapter.name) {
      issues.push('step.name');
    }
    issues.push(...objectMismatches(fact._actual?.with, adapter.with, 'with'));
  } else if (adapter.kind === 'run-step') {
    issues.push(...objectMismatches(fact._actual?.env, adapter.env, 'env'));
    const executableRun = String(fact._actual?.run || '')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const token of adapter.runContains || []) {
      if (!executableRun.includes(token)) {
        issues.push(`run:${token}`);
      }
    }
  }
  return issues;
}
