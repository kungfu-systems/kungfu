#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_AUTHORITY =
  'docs/qualification/gates/workflow-authority.json';
export const WORKFLOW_AUTHORITY_DOC =
  'docs/qualification/gates/workflow-authority.md';
const MATRIX_BEGIN = '<!-- BEGIN GENERATED WORKFLOW AUTHORITY MATRIX -->';
const MATRIX_END = '<!-- END GENERATED WORKFLOW AUTHORITY MATRIX -->';

const WORKFLOW_AUTHORITIES = new Set([
  'qualification',
  'diagnostic',
  'release-control',
  'product-publication',
]);
const JOB_AUTHORITIES = new Set([
  'qualification',
  'diagnostic',
  'release-control',
  'product-publication',
]);
const STEP_AUTHORITIES = new Set([
  'qualification',
  'evidence-publication',
  'diagnostic-write',
  'release-control',
  'product-publication',
]);
const PUBLICATION_CLASSES = new Set(['none', 'evidence', 'product', 'channel']);
const RECEIPT_CLASSES = new Set(['none', 'diagnostic', 'qualifying']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function authorityDigest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function workflowFiles(root) {
  const directory = path.join(root, '.github/workflows');
  return fs
    .readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .sort();
}

function parseWorkflow(root, relative, issues) {
  const document = parseDocument(
    fs.readFileSync(path.join(root, relative), 'utf8'),
    { prettyErrors: false, uniqueKeys: true },
  );
  for (const error of document.errors)
    issues.push(`[workflow-authority-yaml] ${relative}: ${error.message}`);
  return document.errors.length ? null : document.toJS();
}

function workflowDefinition(value) {
  const { jobs: _jobs, ...definition } = value;
  return definition;
}

function permissionMode(permissions) {
  if (permissions === 'write-all') return 'write';
  if (permissions === 'read-all') return 'read';
  if (
    permissions === null ||
    (permissions &&
      typeof permissions === 'object' &&
      !Array.isArray(permissions) &&
      Object.keys(permissions).length === 0)
  )
    return 'none';
  if (!permissions || typeof permissions !== 'object') return 'unspecified';
  if (Object.values(permissions).includes('write')) return 'write';
  if (Object.values(permissions).includes('read')) return 'read';
  return 'none';
}

function secretReferences(value) {
  const serialized = JSON.stringify(value);
  const names = new Set();
  for (const match of serialized.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
    names.add(match[1]);
  for (const match of serialized.matchAll(/secrets\[['"]([^'"]+)['"]\]/g))
    names.add(match[1]);
  return [...names].sort();
}

function environmentName(environment) {
  if (typeof environment === 'string') return environment;
  if (environment && typeof environment === 'object')
    return typeof environment.name === 'string' ? environment.name : 'dynamic';
  return null;
}

function credentialSurface(workflow, job) {
  const permissions = job.permissions ?? workflow.permissions;
  return {
    githubToken: permissionMode(permissions),
    oidc:
      Boolean(permissions) &&
      typeof permissions === 'object' &&
      permissions['id-token'] === 'write',
    repositorySecrets: secretReferences(job),
    inheritedSecrets: job.secrets === 'inherit',
    environment: environmentName(job.environment),
  };
}

function stepLabel(step, index) {
  if (typeof step.id === 'string') return `id:${step.id}`;
  if (typeof step.name === 'string') return `name:${step.name}`;
  if (typeof step.uses === 'string') return `uses:${step.uses}`;
  const firstLine = typeof step.run === 'string' ? step.run.split('\n')[0] : '';
  return `run:${firstLine || `step-${index + 1}`}`;
}

function externalActionReferences(job) {
  const references = [];
  if (typeof job.uses === 'string') references.push(job.uses);
  for (const step of Array.isArray(job.steps) ? job.steps : [])
    if (typeof step.uses === 'string') references.push(step.uses);
  return references.filter(
    (reference) =>
      !reference.startsWith('./') && !reference.startsWith('docker://'),
  );
}

function immutableReference(reference) {
  const marker = reference.lastIndexOf('@');
  return marker > 0 && /^[0-9a-f]{40}$/.test(reference.slice(marker + 1));
}

const BUILDCHAIN_V3_BUILD_ACTION =
  'kungfu-systems/buildchain/.github/workflows/.build.yml@v3-alpha';
const BUILDCHAIN_V3_PROMOTION_ACTION =
  'kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3-alpha';
const BUILDCHAIN_V3_ALPHA_PROMOTION_ACTION =
  'kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3-alpha';
const BUILDCHAIN_V3_MACOS_BURST_ACTION =
  'kungfu-systems/buildchain/.github/workflows/.build.yml@v3';

function authorityReferenceAllowed(workflowPath, jobId, reference) {
  return (
    immutableReference(reference) ||
    (workflowPath.endsWith('/build.yml') &&
      jobId === 'build' &&
      reference === BUILDCHAIN_V3_BUILD_ACTION) ||
    (workflowPath.endsWith('/release-new-version.yml') &&
      jobId === 'promote' &&
      reference === BUILDCHAIN_V3_PROMOTION_ACTION) ||
    (workflowPath.endsWith('/release-new-version.yml') &&
      jobId === 'recover' &&
      reference === BUILDCHAIN_V3_ALPHA_PROMOTION_ACTION) ||
    (workflowPath.endsWith('/aws-us-macos-burst-qualification.yml') &&
      jobId === 'qualify' &&
      reference === BUILDCHAIN_V3_MACOS_BURST_ACTION)
  );
}

function exactKeys(value, keys, location, issues, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`[workflow-authority] ${location} must be an object`);
    return false;
  }
  const allowed = new Set([...keys, ...optional]);
  for (const key of keys)
    if (!Object.hasOwn(value, key))
      issues.push(`[workflow-authority] ${location}.${key} is required`);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      issues.push(`[workflow-authority] ${location}.${key} is not allowed`);
  return true;
}

function initialJobPolicy(workflowPath, jobId) {
  if (workflowPath.endsWith('/publish-layer-artifacts.yml')) {
    if (['publish', 'publish-pypi'].includes(jobId))
      return ['product-publication', 'product', 'none'];
  }
  if (workflowPath.endsWith('/release-new-version.yml')) {
    if (['promote', 'recover'].includes(jobId))
      return ['release-control', 'channel', 'qualifying'];
    if (jobId === 'github-release-latest')
      return ['release-control', 'product', 'qualifying'];
  }
  if (workflowPath.endsWith('/release-shifu.yml') && jobId === 'release')
    return ['product-publication', 'product', 'none'];
  if (workflowPath.endsWith('/dev-verify-patrol.yml') && jobId === 'report')
    return ['diagnostic', 'none', 'none'];
  if (
    workflowPath.endsWith('/dev-gate-latency-patrol.yml') &&
    ['capture', 'collect'].includes(jobId)
  )
    return ['diagnostic', 'evidence', 'diagnostic'];
  if (
    (workflowPath.endsWith('/dev-verify-patrol.yml') && jobId === 'verify') ||
    (workflowPath.endsWith('/gate-measurement.yml') && jobId === 'measure') ||
    (workflowPath.endsWith('/kfd-verifier-drift.yml') &&
      jobId === 'verify-owned-fixtures') ||
    (workflowPath.endsWith('/auditable-demo.yml') &&
      ['build', 'auditable-demo'].includes(jobId)) ||
    (workflowPath.endsWith('/build.yml') && jobId === 'build') ||
    (workflowPath.endsWith('/source-acceptance.yml') &&
      jobId === 'source-acceptance')
  )
    return ['qualification', 'none', 'qualifying'];
  return ['qualification', 'none', 'diagnostic'];
}

function initialStepAuthority(jobAuthority, step) {
  if (jobAuthority === 'product-publication') return 'product-publication';
  if (jobAuthority === 'release-control') return 'release-control';
  if (jobAuthority === 'diagnostic') return 'diagnostic-write';
  if (
    typeof step.uses === 'string' &&
    /(upload-artifact|download-artifact)/.test(step.uses)
  )
    return 'evidence-publication';
  return 'qualification';
}

export function projectWorkflowAuthority(root = ROOT, previous = null) {
  const issues = [];
  const previousWorkflows = new Map(
    (previous?.workflows || []).map((workflow) => [workflow.path, workflow]),
  );
  const workflows = [];
  for (const relative of workflowFiles(root)) {
    const value = parseWorkflow(root, relative, issues);
    if (!value) continue;
    const previousWorkflow = previousWorkflows.get(relative);
    const previousJobs = new Map(
      (previousWorkflow?.jobs || []).map((job) => [job.id, job]),
    );
    const jobs = [];
    for (const [jobId, job] of Object.entries(value.jobs || {}).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const previousJob = previousJobs.get(jobId);
      const [initialAuthority, initialPublication, initialReceipt] =
        initialJobPolicy(relative, jobId);
      const steps = (Array.isArray(job.steps) ? job.steps : []).map(
        (step, index) => {
          const authority =
            previousJob?.steps?.find((item) => item.index === index + 1)
              ?.authority || initialStepAuthority(initialAuthority, step);
          return {
            index: index + 1,
            label: stepLabel(step, index),
            ...(authority === 'qualification' ? {} : { authority }),
            definitionDigest: authorityDigest(step),
          };
        },
      );
      jobs.push({
        id: jobId,
        authority: previousJob?.authority || initialAuthority,
        publication: previousJob?.publication || initialPublication,
        receipt: previousJob?.receipt || initialReceipt,
        definitionDigest: authorityDigest(job),
        credentials: credentialSurface(value, job),
        externalActions: externalActionReferences(job),
        steps,
      });
    }
    workflows.push({
      path: relative,
      authority:
        previousWorkflow?.authority ||
        (jobs.some((job) => job.authority === 'product-publication')
          ? 'product-publication'
          : jobs.some((job) => job.authority === 'release-control')
            ? 'release-control'
            : jobs.some((job) => job.authority === 'diagnostic')
              ? 'diagnostic'
              : 'qualification'),
      definitionDigest: authorityDigest(workflowDefinition(value)),
      jobs,
    });
  }
  return {
    issues,
    document: {
      schema: 'kungfu.workflow-authority/v1',
      workflowRoot: '.github/workflows',
      workflows,
    },
  };
}

function credentialSummary(credentials) {
  const parts = [`token:${credentials.githubToken}`];
  if (credentials.oidc) parts.push('oidc');
  if (credentials.repositorySecrets.length)
    parts.push(`repo-secret:${credentials.repositorySecrets.join('+')}`);
  if (credentials.inheritedSecrets) parts.push('inherited-secrets');
  return parts.join(', ');
}

export function renderWorkflowAuthorityMatrix(document) {
  return [
    '| Workflow | Job | Authority | Publication | Receipt | Credentials | Environment | Steps |',
    '| --- | --- | --- | --- | --- | --- | --- | ---: |',
    ...document.workflows.flatMap((workflow) =>
      workflow.jobs.map(
        (job) =>
          `| \`${workflow.path}\` | \`${job.id}\` | ${job.authority} | ${job.publication} | ${job.receipt} | ${credentialSummary(job.credentials)} | ${job.credentials.environment ? `\`${job.credentials.environment}\`` : 'none'} | ${job.steps.length} |`,
      ),
    ),
  ].join('\n');
}

export function serializeWorkflowAuthority(document) {
  const lines = JSON.stringify(document, null, 2).split('\n');
  const rendered = [];
  for (let index = 0; index < lines.length; index += 1) {
    const stepsMatch = lines[index].match(/^(\s*)"steps": \[$/);
    if (stepsMatch) {
      const indent = stepsMatch[1];
      const arrayLines = ['['];
      let closed = false;
      let suffix = '';
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index] === `${indent}]` || lines[index] === `${indent}],`) {
          closed = true;
          suffix = lines[index].endsWith(',') ? ',' : '';
          break;
        }
        arrayLines.push(lines[index].slice(indent.length));
      }
      if (!closed) throw new Error('unterminated steps serialization');
      arrayLines.push(']');
      rendered.push(
        `${indent}"steps": ${JSON.stringify(JSON.parse(arrayLines.join('\n')))}${suffix}`,
      );
      continue;
    }
    const credentialsMatch = lines[index].match(/^(\s*)"credentials": \{$/);
    if (credentialsMatch) {
      const indent = credentialsMatch[1];
      const objectLines = ['{'];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index] === `${indent}},`) {
          closed = true;
          break;
        }
        objectLines.push(lines[index].trim());
      }
      if (!closed) throw new Error('unterminated credentials serialization');
      objectLines.push('}');
      rendered.push(
        `${indent}"credentials": ${JSON.stringify(JSON.parse(objectLines.join('\n')))},`,
      );
      continue;
    }
    const match = lines[index].match(/^(\s*)"externalActions": \[$/);
    if (!match) {
      rendered.push(lines[index]);
      continue;
    }
    const indent = match[1];
    const values = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index] === `${indent}],`) {
        closed = true;
        break;
      }
      const item = lines[index].trim().replace(/,$/, '');
      if (!/^"(?:[^"\\]|\\.)*"$/.test(item))
        throw new Error('unexpected external action serialization');
      values.push(JSON.parse(item));
    }
    if (!closed) throw new Error('unterminated external action serialization');
    rendered.push(`${indent}"externalActions": ${JSON.stringify(values)},`);
  }
  return `${rendered.join('\n')}\n`;
}

export function replaceWorkflowAuthorityMatrix(text, document) {
  const start = text.indexOf(MATRIX_BEGIN);
  const finish = text.indexOf(MATRIX_END);
  if (start < 0 || finish <= start)
    throw new Error(
      `missing ordered authority matrix markers in ${WORKFLOW_AUTHORITY_DOC}`,
    );
  return `${text.slice(0, start + MATRIX_BEGIN.length)}\n${renderWorkflowAuthorityMatrix(document)}\n${text.slice(finish)}`;
}

function compareProjection(actual, expected, location, issues) {
  if (!isDeepStrictEqual(actual, expected))
    issues.push(
      `[workflow-authority] ${location} drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

export function validateWorkflowAuthority(root = ROOT, document = null) {
  const issues = [];
  const manifest =
    document ||
    JSON.parse(fs.readFileSync(path.join(root, WORKFLOW_AUTHORITY)));
  exactKeys(
    manifest,
    ['schema', 'workflowRoot', 'workflows'],
    'document',
    issues,
  );
  if (manifest.schema !== 'kungfu.workflow-authority/v1')
    issues.push('[workflow-authority] unsupported schema');
  if (manifest.workflowRoot !== '.github/workflows')
    issues.push('[workflow-authority] workflowRoot must be .github/workflows');
  if (!Array.isArray(manifest.workflows)) return { issues, document: manifest };

  const projected = projectWorkflowAuthority(root, manifest);
  issues.push(...projected.issues);
  const actualPaths = projected.document.workflows.map((item) => item.path);
  const declaredPaths = manifest.workflows.map((item) => item.path);
  compareProjection(actualPaths, declaredPaths, 'workflow inventory', issues);
  const actualByPath = new Map(
    projected.document.workflows.map((item) => [item.path, item]),
  );
  const seen = new Set();
  for (const [workflowIndex, workflow] of manifest.workflows.entries()) {
    const at = `workflows[${workflowIndex}]`;
    exactKeys(
      workflow,
      ['path', 'authority', 'definitionDigest', 'jobs'],
      at,
      issues,
    );
    if (seen.has(workflow.path))
      issues.push(`[workflow-authority] duplicate workflow '${workflow.path}'`);
    seen.add(workflow.path);
    if (!WORKFLOW_AUTHORITIES.has(workflow.authority))
      issues.push(`[workflow-authority] ${at}.authority is unsupported`);
    const actualWorkflow = actualByPath.get(workflow.path);
    if (!actualWorkflow) continue;
    const workflowCarriesAuthority = (workflow.jobs || []).some(
      (job) => job.receipt === 'qualifying' || job.publication !== 'none',
    );
    compareProjection(
      actualWorkflow.definitionDigest,
      workflow.definitionDigest,
      `${workflow.path} definition`,
      issues,
    );
    const actualJobIds = actualWorkflow.jobs.map((item) => item.id);
    const declaredJobIds = (workflow.jobs || []).map((item) => item.id);
    compareProjection(
      actualJobIds,
      declaredJobIds,
      `${workflow.path} job inventory`,
      issues,
    );
    const actualJobs = new Map(
      actualWorkflow.jobs.map((item) => [item.id, item]),
    );
    for (const [jobIndex, job] of (workflow.jobs || []).entries()) {
      const jobAt = `${workflow.path}#${job.id}`;
      exactKeys(
        job,
        [
          'id',
          'authority',
          'publication',
          'receipt',
          'definitionDigest',
          'credentials',
          'externalActions',
          'steps',
        ],
        `${at}.jobs[${jobIndex}]`,
        issues,
      );
      if (!JOB_AUTHORITIES.has(job.authority))
        issues.push(`[workflow-authority] ${jobAt}: unsupported authority`);
      if (!PUBLICATION_CLASSES.has(job.publication))
        issues.push(`[workflow-authority] ${jobAt}: unsupported publication`);
      if (!RECEIPT_CLASSES.has(job.receipt))
        issues.push(`[workflow-authority] ${jobAt}: unsupported receipt`);
      if (
        ['product', 'channel'].includes(job.publication) &&
        !['product-publication', 'release-control'].includes(job.authority)
      )
        issues.push(
          `[workflow-authority] ${jobAt}: publication requires publication authority`,
        );
      if (
        job.receipt === 'qualifying' &&
        job.authority !== 'qualification' &&
        job.authority !== 'release-control'
      )
        issues.push(
          `[workflow-authority] ${jobAt}: qualifying receipt requires qualification or release-control authority`,
        );
      const actualJob = actualJobs.get(job.id);
      if (!actualJob) continue;
      if (
        actualJob.credentials.inheritedSecrets &&
        !['product-publication', 'release-control'].includes(job.authority)
      )
        issues.push(
          `[workflow-authority] ${jobAt}: inherited secrets require product-publication or release-control authority`,
        );
      if (
        actualJob.credentials.environment &&
        !['product-publication', 'release-control'].includes(job.authority)
      )
        issues.push(
          `[workflow-authority] ${jobAt}: Environment access requires product-publication or release-control authority`,
        );
      for (const field of [
        'definitionDigest',
        'credentials',
        'externalActions',
      ])
        compareProjection(
          actualJob[field],
          job[field],
          `${jobAt} ${field}`,
          issues,
        );
      if (
        workflowCarriesAuthority &&
        actualJob.externalActions.some(
          (reference) =>
            !authorityReferenceAllowed(workflow.path, job.id, reference),
        )
      )
        issues.push(
          `[workflow-authority] ${jobAt}: authority-bearing workflows require immutable external action refs`,
        );
      const actualStepIndexes = actualJob.steps.map((item) => item.index);
      const declaredStepIndexes = (job.steps || []).map((item) => item.index);
      compareProjection(
        actualStepIndexes,
        declaredStepIndexes,
        `${jobAt} step inventory`,
        issues,
      );
      for (const [stepIndex, step] of (job.steps || []).entries()) {
        exactKeys(
          step,
          ['index', 'label', 'definitionDigest'],
          `${jobAt}.steps[${stepIndex}]`,
          issues,
          ['authority'],
        );
        const stepAuthority = step.authority || 'qualification';
        if (!STEP_AUTHORITIES.has(stepAuthority))
          issues.push(
            `[workflow-authority] ${jobAt}.steps[${stepIndex}]: unsupported authority`,
          );
        const actualStep = actualJob.steps[stepIndex];
        if (!actualStep) continue;
        compareProjection(
          actualStep.label,
          step.label,
          `${jobAt} step ${step.index} label`,
          issues,
        );
        compareProjection(
          actualStep.definitionDigest,
          step.definitionDigest,
          `${jobAt} step ${step.index} definition`,
          issues,
        );
        const permittedStepAuthorities = {
          qualification: ['qualification', 'evidence-publication'],
          diagnostic: ['qualification', 'diagnostic-write'],
          'release-control': [
            'qualification',
            'evidence-publication',
            'release-control',
          ],
          'product-publication': [
            'qualification',
            'evidence-publication',
            'product-publication',
          ],
        };
        if (!permittedStepAuthorities[job.authority]?.includes(stepAuthority))
          issues.push(
            `[workflow-authority] ${jobAt} step ${step.index}: step authority exceeds job authority`,
          );
      }
    }
  }
  return { issues, document: manifest, projection: projected.document };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const refresh = process.argv.includes('--refresh');
  if (refresh) {
    const target = path.join(ROOT, WORKFLOW_AUTHORITY);
    const previous = fs.existsSync(target)
      ? JSON.parse(fs.readFileSync(target, 'utf8'))
      : null;
    const projection = projectWorkflowAuthority(ROOT, previous);
    if (projection.issues.length) {
      console.error(projection.issues.join('\n'));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeWorkflowAuthority(projection.document));
    const docTarget = path.join(ROOT, WORKFLOW_AUTHORITY_DOC);
    if (fs.existsSync(docTarget)) {
      fs.writeFileSync(
        docTarget,
        replaceWorkflowAuthorityMatrix(
          fs.readFileSync(docTarget, 'utf8'),
          projection.document,
        ),
      );
    }
    console.log(`refreshed ${WORKFLOW_AUTHORITY}`);
  } else {
    const result = validateWorkflowAuthority(ROOT);
    if (result.issues.length) {
      console.error(result.issues.join('\n'));
      process.exit(1);
    }
    console.log('Kungfu workflow authority: closed world verified');
  }
}
