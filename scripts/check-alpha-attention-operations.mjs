#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './readonly-source-toolchain.mjs';

import { buildAlphaAttentionActivationPlan } from './alpha-attention-activation.mjs';
import {
  attentionBand,
  buildTriageProposal,
} from './alpha-attention-operations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORM_ROOT = path.join(ROOT, '.github', 'ISSUE_TEMPLATE');
const CONTRACT_PATH = path.join(
  ROOT,
  '.github',
  'alpha-attention-operations.json',
);
const FIXTURE_PATH = path.join(
  ROOT,
  'docs',
  'qualification',
  'fixtures',
  'alpha-attention-operations',
  'rehearsal.json',
);

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
export function checkAlphaAttentionOperations(root = ROOT) {
  const issues = [];
  const contract = JSON.parse(
    read(path.join(root, '.github', 'alpha-attention-operations.json')),
  );
  const fixture = JSON.parse(
    read(
      path.join(
        root,
        'docs',
        'qualification',
        'fixtures',
        'alpha-attention-operations',
        'rehearsal.json',
      ),
    ),
  );
  const community = JSON.parse(
    read(path.join(root, '.github', 'community-health-baseline.json')),
  );

  requireCheck(
    issues,
    contract.$schema === 'kungfu.alpha-attention-operations/v1',
    'operations contract schema drifted',
  );
  requireCheck(
    issues,
    contract.activation?.state === 'blocked',
    'Alpha activation must remain fail-closed',
  );
  requireCheck(
    issues,
    contract.activation?.targetRepository === 'kungfu-systems/kungfu' &&
      JSON.stringify(contract.activation.requiredDiscussionCategories) ===
        JSON.stringify([
          { name: 'Q&A', slug: 'q-a', isAnswerable: true },
          { name: 'Ideas', slug: 'ideas', isAnswerable: false },
          {
            name: 'Show and tell',
            slug: 'show-and-tell',
            isAnswerable: false,
          },
        ]) &&
      contract.activation?.requiredActiveRulesets?.includes(
        'Buildchain dev merge queue: dev/v4/v4.0',
      ) &&
      community.defaultRepository?.target === 'kungfu-systems/.github' &&
      community.defaultRepository?.requiredFiles?.length === 8,
    'live activation target or required readback contract drifted',
  );
  requireCheck(
    issues,
    contract.agentAssistance?.liveMutation === false &&
      contract.agentAssistance?.publicInputTrust === 'untrusted-data-only' &&
      contract.agentAssistance?.consequentialDecision ===
        'human-review-required',
    'agent assistance boundary drifted',
  );
  const staffing = contract.staffing;
  const staffingFixture = fixture.staffingCase;
  const roleBindings = Array.isArray(staffing?.roleBindings)
    ? staffing.roleBindings
    : [];
  const boundRoles = new Set(roleBindings.map((binding) => binding.role));
  requireCheck(
    issues,
    staffing?.timezone === staffingFixture?.timezone &&
      staffing?.humanOperatorCount === staffingFixture?.humanOperatorCount &&
      staffing?.primaryHumanAccount === staffingFixture?.primaryHumanAccount &&
      staffing?.secondaryReviewAccount ===
        staffingFixture?.secondaryReviewAccount &&
      staffing?.secondaryAccountIsIndependentHuman === false,
    'single-operator account binding drifted',
  );
  requireCheck(
    issues,
    staffingFixture?.requiredRoles?.every(
      (role) =>
        boundRoles.has(role) &&
        roleBindings.some(
          (binding) =>
            binding.role === role &&
            binding.primaryAccount === staffingFixture.primaryHumanAccount &&
            binding.secondaryAccount === staffingFixture.secondaryReviewAccount,
        ),
    ),
    'one or more operational roles lack the declared account binding',
  );
  requireCheck(
    issues,
    staffing?.monitoredWindow === staffingFixture?.monitoredWindow &&
      staffing?.protectedRestWindow === staffingFixture?.protectedRestWindow &&
      staffing?.launchStartWindow === staffingFixture?.launchStartWindow &&
      staffing?.restWindowPolicy?.readOnlyCollectionAndDraftingAllowed ===
        true &&
      staffing?.restWindowPolicy?.publicMutationAllowed === false &&
      staffing?.restWindowPolicy?.securityDispositionAllowed === false &&
      staffing?.restWindowPolicy?.moderationDecisionAllowed === false &&
      staffing?.restWindowPolicy?.availabilityClaimAllowed === false &&
      staffing?.restWindowPolicy?.promotionRemainsPaused === true,
    'single-operator rest window is not fail-closed',
  );
  const activationPlan = buildAlphaAttentionActivationPlan(
    contract,
    community,
    {
      organizationDefaultRepository: { exists: false, files: [] },
      repository: { hasIssues: true, hasDiscussions: false },
      discussionCategories: [],
      labels: [],
      privateVulnerabilityReporting: true,
      activeRulesets: [
        {
          name: 'Buildchain dev merge queue: dev/v4/v4.0',
          enforcement: 'active',
        },
      ],
      interactionLimit: null,
    },
  );
  requireCheck(
    issues,
    activationPlan.mode === 'dry-run' &&
      activationPlan.liveMutation === false &&
      activationPlan.executable === false &&
      activationPlan.status === 'blocked' &&
      activationPlan.proposedMutations.every(
        (item) => item.authority === 'human-confirmation-required',
      ),
    'live activation planner is not deterministic and fail-closed',
  );

  const labelNames = contract.labels.map((label) => label.name);
  requireCheck(
    issues,
    new Set(labelNames).size === labelNames.length,
    'label names must be unique',
  );
  for (const dimension of [
    'kind/',
    'area/',
    'state/',
    'platform/',
    'impact/',
    'source/',
  ]) {
    requireCheck(
      issues,
      labelNames.some((name) => name.startsWith(dimension)),
      `label dimension ${dimension} is missing`,
    );
  }
  requireCheck(
    issues,
    labelNames.includes('source/external') &&
      labelNames.includes('source/automation'),
    'source labels must separate external and automation intake',
  );

  const requiredFormFields = new Set([
    'version',
    'install-channel',
    'os-arch',
    'provider-agent',
    'expected',
    'actual',
    'reproduction',
    'diagnostics',
    'impact',
    'safety',
  ]);
  for (const filename of [
    'bug.yml',
    'install.yml',
    'documentation.yml',
    'feature.yml',
  ]) {
    const form = parse(
      read(path.join(root, '.github', 'ISSUE_TEMPLATE', filename)),
    );
    const ids = new Set(
      form.body.map((entry) => entry.id).filter((id) => typeof id === 'string'),
    );
    for (const id of requiredFormFields) {
      requireCheck(
        issues,
        ids.has(id),
        `${filename} is missing required field ${id}`,
      );
    }
    requireCheck(
      issues,
      form.labels.includes('source/external') &&
        form.labels.includes('state/needs-triage'),
      `${filename} does not enter the external triage queue`,
    );
    const safety = form.body.find((entry) => entry.id === 'safety');
    requireCheck(
      issues,
      safety?.attributes?.options?.every((option) => option.required === true),
      `${filename} safety acknowledgements must be required`,
    );
  }
  requireCheck(
    issues,
    !fs
      .readdirSync(path.join(root, '.github', 'ISSUE_TEMPLATE'))
      .some((name) => name.endsWith('.md')),
    'legacy free-form issue templates remain active',
  );

  const config = read(
    path.join(root, '.github', 'ISSUE_TEMPLATE', 'config.yml'),
  );
  requireCheck(
    issues,
    config.includes('/discussions/new?category=q-a') &&
      config.includes('/discussions/new?category=ideas') &&
      config.includes('/discussions/new?category=show-and-tell') &&
      config.includes('/security/advisories/new'),
    'Issue chooser routing is incomplete',
  );

  const workflow = read(
    path.join(root, '.github', 'workflows', 'dev-verify-patrol.yml'),
  );
  requireCheck(
    issues,
    workflow.includes('kungfu-attention-source: automation') &&
      workflow.includes('source/automation') &&
      workflow.includes('kind/internal'),
    'dev patrol tracker is not isolated in the automation lane',
  );

  const runbook = read(
    path.join(root, 'docs', 'development', 'alpha-attention-operations.md'),
  );
  for (const expected of [
    'T-24',
    'T+48',
    '0-10',
    '11-30',
    '31-60',
    'More than 60',
    'Pause promotional amplification',
    'freeze unrelated development',
    '--method DELETE repos/kungfu-systems/kungfu/interaction-limits',
    'humanReviewRequired: true',
    '`dongkeren`',
    '`kungfu-origin`',
    '00:00-08:00',
    'not a second human',
  ]) {
    requireCheck(
      issues,
      runbook.toLowerCase().includes(expected.toLowerCase()),
      `runbook is missing ${expected}`,
    );
  }
  const status = read(path.join(root, 'docs', 'guides', 'alpha-status.md'));
  const known = read(path.join(root, 'docs', 'guides', 'known-issues.md'));
  requireCheck(
    issues,
    status.includes('product Alpha publication is blocked') &&
      status.includes('no public response-time SLA'),
    'Alpha Status overclaims availability or support',
  );
  requireCheck(
    issues,
    known.includes('canonical public index') &&
      known.includes('Only a human maintainer closes'),
    'Known Issues duplicate policy drifted',
  );
  const conduct = read(path.join(root, 'CODE_OF_CONDUCT.md'));
  requireCheck(
    issues,
    conduct.includes('Strong criticism') &&
      conduct.includes('must never be used to hide'),
    'Code of Conduct does not preserve criticism boundary',
  );

  const malicious = buildTriageProposal(
    fixture.maliciousIssue,
    fixture.duplicateCorpus,
    fixture.knownIssueIndex,
  );
  requireCheck(
    issues,
    malicious.publicTextExecuted === false &&
      malicious.humanReviewRequired === true &&
      malicious.mutations.length === 0 &&
      malicious.duplicateCandidates.some(
        (candidate) => candidate.number === 810,
      ),
    'malicious-text or duplicate rehearsal failed',
  );
  requireCheck(
    issues,
    !JSON.stringify(malicious).includes('touch /tmp/kungfu-issue-owned') &&
      !JSON.stringify(malicious).includes('ghp_EXAMPLE_NOT_A_SECRET'),
    'triage proposal repeated untrusted diagnostics',
  );
  for (const testCase of fixture.thresholdCases) {
    requireCheck(
      issues,
      attentionBand(testCase.externalIssues, {
        credibleSecurity: testCase.credibleSecurity,
        credibleDataLoss: testCase.credibleDataLoss,
      }) === testCase.expectedBand,
      `threshold case ${JSON.stringify(testCase)} failed`,
    );
  }

  const evidence = {
    schema: 'kungfu.alpha-attention-operations-rehearsal/v1',
    verdict: issues.length === 0 ? 'pass' : 'fail',
    liveMutation: false,
    checks: [
      'issue-form-validation',
      'routing',
      'label-taxonomy',
      'automation-separation',
      'malicious-text-as-data',
      'duplicate-candidates',
      'known-issues',
      'threshold-transitions',
      'handoff-and-roles',
      'single-operator-rest-coverage',
      'deterministic-live-activation-dry-run',
      'moderation-rollback',
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
  const result = checkAlphaAttentionOperations();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict !== 'pass') process.exitCode = 1;
}
