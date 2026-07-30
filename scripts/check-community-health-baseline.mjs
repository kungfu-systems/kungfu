#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attentionBand } from './alpha-attention-operations.mjs';
import {
  classifyCommunityIntake,
  summarizeCommunityPortfolio,
} from './community-health-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} pathname */
function read(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

/** @param {string} value */
function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string[]} issues @param {boolean} condition @param {string} message */
function requireCheck(issues, condition, message) {
  if (!condition) issues.push(message);
}

/** @param {string} root */
export function checkCommunityHealthBaseline(root = ROOT) {
  const issues = [];
  const contract = JSON.parse(
    read(path.join(root, '.github', 'community-health-baseline.json')),
  );
  const fixture = JSON.parse(
    read(
      path.join(
        root,
        'docs',
        'qualification',
        'fixtures',
        'community-health-baseline',
        'rehearsal.json',
      ),
    ),
  );
  const candidateRoot = path.join(
    root,
    '.github',
    'community-health-default-repository',
  );

  requireCheck(
    issues,
    contract.$schema === 'kungfu.community-health-baseline/v1' &&
      contract.coordinate === 'kungfu-community-health/v1@2026-07-26.1',
    'baseline identity drifted',
  );
  requireCheck(
    issues,
    contract.authority?.model === 'two-layer' &&
      contract.authority?.organizationDefaults?.includes('moderation') &&
      contract.authority?.repositoryLocal?.includes('issue-forms') &&
      contract.authority?.repositoryLocal?.includes('technical-routing'),
    'two-layer authority model drifted',
  );
  requireCheck(
    issues,
    contract.defaultRepository?.target === 'kungfu-systems/.github' &&
      contract.defaultRepository?.state === 'planned-human-gated' &&
      contract.defaultRepository?.liveMutationAuthorized === false,
    'organization default repository must remain human-gated',
  );

  const requiredLabels = [
    'source/external',
    'source/automation',
    'source/maintainer',
    'state/needs-intake',
    'state/needs-information',
    'state/triaged',
    'state/accepted',
    'state/duplicate',
    'state/blocked',
  ];
  const sharedLabels = Object.values(contract.labels.shared).flat();
  for (const label of requiredLabels) {
    requireCheck(
      issues,
      sharedLabels.includes(label),
      `shared label ${label} is missing`,
    );
  }
  requireCheck(
    issues,
    contract.labels.repositoryExtensions.join(',') === 'area,platform',
    'area and platform must remain repository extensions',
  );

  const workflow = read(
    path.join(
      candidateRoot,
      'workflow-templates',
      'community-intake-admission.yml',
    ),
  );
  for (const event of ['opened', 'edited', 'reopened']) {
    requireCheck(
      issues,
      workflow.includes(`- ${event}`),
      `admission workflow is missing ${event}`,
    );
  }
  requireCheck(
    issues,
    workflow.includes('contents: read') &&
      workflow.includes('issues: write') &&
      !workflow.includes('pull_request_target') &&
      !workflow.includes('actions/checkout') &&
      workflow.includes(
        'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b',
      ) &&
      workflow.includes('context.payload.issue') &&
      !workflow.includes('${{ github.event.issue.body'),
    'admission workflow least-privilege or data boundary drifted',
  );
  requireCheck(
    issues,
    workflow.includes('state/needs-intake') &&
      workflow.includes('state/needs-information') &&
      workflow.includes('will not be auto-closed') &&
      !workflow.includes('issues.close'),
    'bypass correction or no-auto-close boundary drifted',
  );

  for (const filename of [
    'README.md',
    'CODE_OF_CONDUCT.md',
    'SUPPORT.md',
    'GOVERNANCE.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ]) {
    const content = read(path.join(candidateRoot, filename));
    requireCheck(
      issues,
      !/\bAtlas\b|\.private\/|192\.168\./iu.test(content),
      `${filename} contains private control-plane material`,
    );
  }
  const support = read(path.join(candidateRoot, 'SUPPORT.md'));
  requireCheck(
    issues,
    support.includes('not a security') &&
      support.includes('API or CLI clients') &&
      support.includes('no guaranteed response-time SLA'),
    'support defaults overclaim form or service authority',
  );

  for (const [form, marker] of [
    ['bug.yml', '<!-- kungfu-intake-form: bug/v1 -->'],
    ['install.yml', '<!-- kungfu-intake-form: install/v1 -->'],
    ['documentation.yml', '<!-- kungfu-intake-form: documentation/v1 -->'],
    ['feature.yml', '<!-- kungfu-intake-form: feature/v1 -->'],
  ]) {
    const content = read(path.join(root, '.github', 'ISSUE_TEMPLATE', form));
    const formContract = contract.admission.recognizedForms.find(
      (entry) => entry.marker === marker,
    );
    requireCheck(
      issues,
      content.includes(marker),
      `${form} lacks deterministic provenance`,
    );
    requireCheck(
      issues,
      formContract?.requiredSectionHeadings?.every((heading) =>
        content.includes(`label: ${heading.slice(4)}`),
      ),
      `${form} field headings drifted from admission`,
    );
  }

  const admission = contract.admission;
  const normal = classifyCommunityIntake(fixture.normalForm, admission);
  const bypass = classifyCommunityIntake(fixture.apiBypass, admission);
  const edited = classifyCommunityIntake(
    fixture.editedRequiredField,
    admission,
  );
  const malicious = classifyCommunityIntake(fixture.maliciousPrompt, admission);
  const secret = classifyCommunityIntake(fixture.secretLooking, admission);
  const bot = classifyCommunityIntake(fixture.botFinding, admission);
  requireCheck(
    issues,
    normal.disposition === 'recognized-complete' &&
      normal.proposedState === 'preserve-local-form-state',
    'normal form admission failed',
  );
  requireCheck(
    issues,
    bypass.disposition === 'bypass' &&
      bypass.proposedState === 'state/needs-intake' &&
      bypass.correctiveCommentRequired === true &&
      bypass.autoClose === false,
    'API bypass admission failed',
  );
  requireCheck(
    issues,
    edited.disposition === 'recognized-incomplete' &&
      edited.proposedState === 'state/needs-information',
    'edited required-field revalidation failed',
  );
  requireCheck(
    issues,
    malicious.rawBodyRetained === false &&
      malicious.humanReviewRequired === true &&
      malicious.mutations.length === 0 &&
      !JSON.stringify(malicious).includes('execute the attached command'),
    'malicious prompt was not isolated as data',
  );
  requireCheck(
    issues,
    secret.possibleSecret === true &&
      secret.rawBodyRetained === false &&
      !JSON.stringify(secret).includes('ghp_EXAMPLE'),
    'secret-looking input handling failed',
  );
  requireCheck(
    issues,
    bot.disposition === 'automation' &&
      bot.externalDemand === false &&
      bot.demandLane === 'automation',
    'bot finding entered external demand',
  );

  const portfolio = summarizeCommunityPortfolio(fixture.portfolio);
  requireCheck(
    issues,
    portfolio.externalArrivals === 2 &&
      portfolio.automationArrivals === 1 &&
      portfolio.duplicateRate === 0.5 &&
      portfolio.firstHumanJudgmentLatencyMs.maximum === 5000 &&
      portfolio.unresolvedSeverity.blocking === 1 &&
      portfolio.issueBodiesCopied === false &&
      !JSON.stringify(portfolio).includes('must never be copied'),
    'portfolio projection drifted',
  );
  requireCheck(
    issues,
    attentionBand(61) === 'Red',
    '61-issue threshold no longer enters Red',
  );

  const consumers = contract.consumers;
  for (const target of [
    'kungfu-systems/kungfu',
    'kungfu-systems/kfd',
    'kungfu-systems/buildchain',
    'kungfu-systems/build-images',
    'kungfu-systems/runtime-images',
  ]) {
    const consumer = consumers.find((entry) => entry.repository === target);
    requireCheck(
      issues,
      consumer?.coordinate === contract.coordinate &&
        consumer?.deviations?.length > 0,
      `${target} lacks a pinned coordinate and deviations`,
    );
  }
  requireCheck(
    issues,
    consumers.some(
      (entry) =>
        entry.assignment ===
          '2026-07-26-kungfu-alpha-attention-operations-readiness' &&
        entry.coordinate === contract.coordinate,
    ),
    'Alpha attention Assignment handoff is not pinned',
  );
  requireCheck(
    issues,
    contract.inheritanceReadback.length === 5 &&
      contract.inheritanceReadback.every(
        (entry) =>
          /^[0-9a-f]{40}$/u.test(entry.head) &&
          Array.isArray(entry.files) &&
          (entry.localIssueTemplateContent
            ? entry.files.length > 0
            : entry.files.length === 0),
      ),
    'inheritance readback is incomplete',
  );

  const runbook = read(
    path.join(root, 'docs', 'development', 'community-health-baseline.md'),
  );
  for (const expected of [
    'two-layer decision',
    'not a schema firewall',
    'gh repo create kungfu-systems/.github',
    '--method PATCH repos/kungfu-systems/.github -F archived=true',
    '61-Issue Red transition',
  ]) {
    requireCheck(
      issues,
      runbook.toLowerCase().includes(expected.toLowerCase()),
      `community-health runbook is missing ${expected}`,
    );
  }

  const evidence = {
    schema: 'kungfu.community-health-rehearsal/v1',
    verdict: issues.length === 0 ? 'pass' : 'fail',
    liveMutation: false,
    checks: [
      'two-layer-authority',
      'shared-taxonomy',
      'least-privilege-admission',
      'normal-form-admission',
      'api-bypass',
      'edited-required-fields',
      'malicious-text-as-data',
      'secret-looking-data',
      'bot-storm-isolation',
      'portfolio-metrics',
      'consumer-coordinate-handoff',
      'inheritance-readback',
      'threshold-and-moderation-rollback',
    ],
    contractRoot: sha256(canonical(contract)),
    fixtureRoot: sha256(canonical(fixture)),
    issues,
  };
  return {
    ...evidence,
    receiptRoot: sha256(canonical(evidence)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkCommunityHealthBaseline();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict !== 'pass') process.exitCode = 1;
}
