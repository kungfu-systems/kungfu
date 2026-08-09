// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Live GitHub state is untrusted observation data. This module is a pure,
 * deterministic planner: it has no process, shell, network, dynamic import, or
 * filesystem capability, and it never authorizes or executes a mutation.
 */

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function rows(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry !== null && typeof entry === 'object')
    : [];
}

/** @param {unknown} value */
function strings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/** @param {string[]} values */
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * @param {Record<string, unknown>} operations
 * @param {Record<string, unknown>} community
 * @param {Record<string, unknown>} observed
 */
export function buildAlphaAttentionActivationPlan(
  operations,
  community,
  observed,
) {
  const activation =
    operations.activation && typeof operations.activation === 'object'
      ? operations.activation
      : {};
  const defaultRepository =
    community.defaultRepository &&
    typeof community.defaultRepository === 'object'
      ? community.defaultRepository
      : {};
  const targetRepository = text(activation.targetRepository);
  const organizationRepository = text(defaultRepository.target);
  const requiredFiles = strings(defaultRepository.requiredFiles);
  const requiredCategories = rows(activation.requiredDiscussionCategories);
  const requiredLabels = rows(operations.labels);
  const requiredRulesets = strings(activation.requiredActiveRulesets);

  const observedOrganization =
    observed.organizationDefaultRepository &&
    typeof observed.organizationDefaultRepository === 'object'
      ? observed.organizationDefaultRepository
      : {};
  const observedRepository =
    observed.repository && typeof observed.repository === 'object'
      ? observed.repository
      : {};
  const observedCategories = rows(observed.discussionCategories);
  const observedLabels = rows(observed.labels);
  const observedRulesets = rows(observed.activeRulesets);
  const observedFiles = new Set(strings(observedOrganization.files));

  const missingFiles = requiredFiles.filter((file) => !observedFiles.has(file));
  const missingCategories = requiredCategories.filter(
    (required) =>
      !observedCategories.some(
        (entry) =>
          text(entry.slug) === text(required.slug) &&
          text(entry.name) === text(required.name) &&
          entry.isAnswerable === required.isAnswerable,
      ),
  );
  const missingLabels = requiredLabels.filter(
    (required) =>
      !observedLabels.some((entry) => text(entry.name) === text(required.name)),
  );
  const driftedLabels = requiredLabels
    .map((required) => {
      const current = observedLabels.find(
        (entry) => text(entry.name) === text(required.name),
      );
      if (
        !current ||
        (text(current.color).toLowerCase() ===
          text(required.color).toLowerCase() &&
          text(current.description) === text(required.description))
      ) {
        return null;
      }
      return {
        name: text(required.name),
        expected: {
          color: text(required.color).toLowerCase(),
          description: text(required.description),
        },
        observed: {
          color: text(current.color).toLowerCase(),
          description: text(current.description),
        },
      };
    })
    .filter(Boolean);
  const missingRulesets = requiredRulesets.filter(
    (name) =>
      !observedRulesets.some(
        (entry) =>
          text(entry.name) === name && text(entry.enforcement) === 'active',
      ),
  );

  const blockers = [];
  if (!targetRepository) blockers.push('contract-target-repository-missing');
  if (!organizationRepository) {
    blockers.push('contract-organization-repository-missing');
  }
  if (requiredFiles.length === 0) {
    blockers.push('contract-default-files-missing');
  }
  if (requiredCategories.length === 0) {
    blockers.push('contract-discussion-categories-missing');
  }
  if (requiredLabels.length === 0) blockers.push('contract-labels-missing');
  if (requiredRulesets.length === 0) {
    blockers.push('contract-active-rulesets-missing');
  }
  if (observedOrganization.exists !== true) {
    blockers.push('organization-default-repository-missing');
  } else {
    blockers.push(
      ...missingFiles.map((file) => `default-file-missing:${file}`),
    );
  }
  if (observedRepository.hasIssues !== true) blockers.push('issues-disabled');
  if (observedRepository.hasDiscussions !== true) {
    blockers.push('discussions-disabled');
  }
  blockers.push(
    ...missingCategories.map(
      (category) => `discussion-category-missing:${text(category.slug)}`,
    ),
    ...missingLabels.map((label) => `label-missing:${text(label.name)}`),
    ...driftedLabels.map((label) => `label-drift:${label.name}`),
    ...missingRulesets.map((name) => `active-ruleset-missing:${name}`),
  );
  if (observed.privateVulnerabilityReporting !== true) {
    blockers.push('private-vulnerability-reporting-disabled-or-unreadable');
  }
  if (observed.interactionLimit !== null) {
    blockers.push('interaction-limit-active-or-unreadable');
  }

  const proposedMutations = [];
  if (observedOrganization.exists !== true) {
    proposedMutations.push({
      id: 'create-organization-default-repository',
      authority: 'human-confirmation-required',
      target: organizationRepository,
      command: [
        'gh',
        'repo',
        'create',
        organizationRepository,
        '--public',
        '--description',
        'Public community health defaults for Kungfu Systems',
        '--disable-issues',
        '--disable-wiki',
      ],
      impact: 'Creates one public organization profile repository.',
      rollback: {
        action: 'archive-repository',
        destructiveDeletionAllowed: false,
      },
    });
  }
  if (observedOrganization.exists !== true || missingFiles.length > 0) {
    proposedMutations.push({
      id: 'publish-community-health-defaults',
      authority: 'human-confirmation-required',
      target: `${organizationRepository}:main`,
      sourceRoot: text(defaultRepository.candidateRoot),
      files: requiredFiles,
      impact:
        'Publishes organization-wide community health defaults and workflow templates.',
      rollback: {
        action: 'reviewed-revert-commit',
        destructiveDeletionAllowed: false,
      },
    });
  }
  if (observedRepository.hasDiscussions !== true) {
    proposedMutations.push({
      id: 'enable-discussions',
      authority: 'human-confirmation-required',
      target: targetRepository,
      command: [
        'gh',
        'api',
        '--method',
        'PATCH',
        `repos/${targetRepository}`,
        '-F',
        'has_discussions=true',
      ],
      impact: 'Enables the public Discussions surface for open-ended intake.',
      rollback: {
        command: [
          'gh',
          'api',
          '--method',
          'PATCH',
          `repos/${targetRepository}`,
          '-F',
          'has_discussions=false',
        ],
        precondition: 'Preserve or relocate all real Discussion content first.',
      },
    });
  }
  for (const label of missingLabels) {
    proposedMutations.push({
      id: `create-label:${text(label.name)}`,
      authority: 'human-confirmation-required',
      target: targetRepository,
      command: [
        'gh',
        'api',
        '--method',
        'POST',
        `repos/${targetRepository}/labels`,
        '-f',
        `name=${text(label.name)}`,
        '-f',
        `color=${text(label.color)}`,
        '-f',
        `description=${text(label.description)}`,
      ],
      impact: 'Creates one missing repository label without changing others.',
      rollback: {
        action: 'delete-only-if-new-and-unused',
        label: text(label.name),
      },
    });
  }

  const manualBlocked = [
    ...missingCategories.map((category) => ({
      id: `discussion-category:${text(category.slug)}`,
      reason:
        'Enable Discussions, read back GitHub defaults, and require human review before creating or rerouting a category.',
    })),
    ...driftedLabels.map((label) => ({
      id: `label-drift:${label.name}`,
      reason:
        'An existing label differs from the contract; renaming or rewriting it requires a separately reviewed migration.',
    })),
    ...missingRulesets.map((name) => ({
      id: `active-ruleset:${name}`,
      reason:
        'Protected review and merge-queue policy must not be created or weakened by this activation planner.',
    })),
  ];
  if (observed.privateVulnerabilityReporting !== true) {
    manualBlocked.push({
      id: 'private-vulnerability-reporting',
      reason:
        'Security reporting must remain a separately authorized repository-security decision.',
    });
  }
  if (observed.interactionLimit !== null) {
    manualBlocked.push({
      id: 'interaction-limit',
      reason:
        'The normal readiness state has no restriction; changing an active or unreadable limit requires incident authority.',
    });
  }

  return {
    schema: 'kungfu.alpha-attention-activation-plan/v1',
    mode: 'dry-run',
    liveMutation: false,
    executable: false,
    humanConfirmationRequired: true,
    targetRepository,
    organizationRepository,
    status: blockers.length === 0 ? 'ready' : 'blocked',
    blockers: uniqueSorted(blockers),
    differences: {
      missingDefaultFiles: missingFiles,
      missingDiscussionCategories: missingCategories,
      missingLabels,
      driftedLabels,
      missingActiveRulesets: missingRulesets,
    },
    proposedMutations,
    manualBlocked,
    readbacks: [
      ['gh', 'api', `repos/${targetRepository}`],
      ['gh', 'api', `repos/${targetRepository}/labels`, '--paginate'],
      [
        'gh',
        'api',
        `repos/${targetRepository}/private-vulnerability-reporting`,
      ],
      ['gh', 'api', `repos/${targetRepository}/rulesets`],
      ['gh', 'api', `repos/${targetRepository}/interaction-limits`],
    ],
  };
}
