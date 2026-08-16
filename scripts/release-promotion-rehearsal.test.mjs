// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractWorkflowJob,
  runFixtureSuite,
  runRehearsal,
  validatePromotionContract,
  validateWorkflowSources,
} from './release-promotion-rehearsal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs/release-promotion-rehearsal.contract.json'),
    'utf8',
  ),
);
const RELEASE_ADMISSION = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs/qualification/gates/release-admission-policy.json'),
    'utf8',
  ),
);

test('the committed Buildchain promotion consumer contract is coherent', () => {
  const result = validatePromotionContract(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test('release tails consume Buildchain results without a product-specific admission stage', () => {
  const build = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.build),
    'utf8',
  );
  assert.doesNotMatch(
    build,
    /finalize-upgrade-publication-admission|upgrade-publication-admission\.mjs/u,
  );
  for (const relativePath of [
    'scripts/buildchain-custom-publish-evidence.mjs',
    'scripts/alpha-publication-commit.mjs',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /UpgradePublicationAdmission|upgrade-publication-admission/u,
      relativePath,
    );
  }
});

test('the expensive build retains preflight when additional fast sentinels are required', () => {
  const buildPath = CONTRACT.workflows.build;
  const original = fs.readFileSync(path.join(ROOT, buildPath), 'utf8');
  const drifted = original.replace(
    'needs: [preflight, windows-fast-sentinel, auditable-demo-fast-sentinel]',
    'needs: [windows-fast-sentinel, auditable-demo-fast-sentinel]',
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    build: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('must depend on Alpha preflight admission'),
    ),
  );
});

test('alpha and stable promotion fixtures cover admission and fail-closed paths', () => {
  const result = runFixtureSuite(ROOT);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.fixtures.map((fixture) => [fixture.base_ref, fixture.expected_ok]),
    [
      ['alpha/v4/v4.0', false],
      ['alpha/v4/v4.0', true],
      ['release/v4/v4.0', false],
      ['release/v4/v4.0', true],
    ],
  );
});

test('promotion workflow drift is rejected before Buildchain promotion', () => {
  const promotionPath = CONTRACT.workflows.promotion;
  const original = fs.readFileSync(path.join(ROOT, promotionPath), 'utf8');
  const drifted = original.replace(
    'required-status-check: build / Finalize build controller evidence',
    'required-status-check: skipped',
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    promotion: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('required status check drifted'),
    ),
  );
});

test('Linux artifact attestation subject and provider permissions fail closed on drift', () => {
  const build = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.build),
    'utf8',
  );
  const promotion = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    build: build
      .replace(
        CONTRACT.buildchain.artifact_attestation.subject_path,
        'product/release/cli/wrong-linux-subject.tar.gz',
      )
      .replace(
        CONTRACT.buildchain.artifact_attestation.signer_sha,
        'f'.repeat(40),
      ),
    promotion: promotion.replace('attestations: write', 'attestations: read'),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('exact Linux CLI attestation subject'),
    ),
  );
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('attestations: write'),
    ),
  );
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('immutable Buildchain signer bootstrap'),
    ),
  );
});

test('promotion caller grants the write permissions required by Buildchain', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const promote = extractWorkflowJob(workflow, 'promote');
  assert.ok(promote);
  for (const permission of ['actions', 'checks', 'pull-requests']) {
    assert.match(promote, new RegExp(`^      ${permission}: write$`, 'mu'));
  }
});

test('promotion caller and recovery use the v3-alpha floating router', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const promote = extractWorkflowJob(workflow, 'promote');
  assert.ok(promote);
  assert.match(
    promote,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@v3/u,
  );
  assert.doesNotMatch(promote, /release-candidate-promote\.yml@[0-9a-f]{40}/u);
});

test('publication and recovery clear activation commands while preserving publication surfaces', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const jobs = [
    ['promote', extractWorkflowJob(workflow, 'promote')],
    ['recover', extractWorkflowJob(workflow, 'recover')],
  ];
  for (const [name, job] of jobs) {
    assert.ok(job, name);
    assert.match(job, /release-activation-command: ""/u, name);
    assert.match(job, /release-passport-evidence-command: ""/u, name);
    assert.match(
      job,
      name === 'recover'
        ? /publish-command: node \.buildchain\/publication-controller\/scripts\/buildchain-custom-publish-evidence\.mjs/u
        : /publish-command: node scripts\/buildchain-custom-publish-evidence\.mjs/u,
      name,
    );
    assert.match(
      job,
      name === 'recover'
        ? /release-passport-kfd-3-artifact-verify-command: node "\$GITHUB_WORKSPACE\/\.buildchain\/publication-controller\/scripts\/buildchain-kfd-evidence\.mjs" --write --json >\/dev\/null && node "\$GITHUB_WORKSPACE\/\.buildchain\/publication-controller\/scripts\/buildchain-kfd-evidence\.mjs" --artifact-witness --json/u
        : /release-passport-kfd-3-artifact-verify-command: node scripts\/buildchain-kfd-evidence\.mjs --artifact-witness --json/u,
      name,
    );
    assert.match(
      job,
      /publication-commit-evidence-path: \.buildchain\/publication-commit\/evidence\.json/u,
      name,
    );
    assert.match(job, /release-passport: true/u, name);
    assert.match(
      job,
      /publication-target: github-release:kungfu-systems\/kungfu/u,
      name,
    );
    assert.match(
      job,
      /github-release-payload-patterns:[\s\S]*kungfu-episodes-cli-\*\.tar\.gz[\s\S]*kungfu-episodes-cli-\*\.zip[\s\S]*kungfu-episodes-cli-\*\.qualification\.json[\s\S]*Kungfu-Episodes-\*-macos-arm64\.dmg[\s\S]*Kungfu-Episodes-\*-macos-arm64\.zip[\s\S]*Kungfu Episodes-\*\.AppImage[\s\S]*Kungfu Episodes Setup \*\.exe/u,
      name,
    );
  }
  assert.match(
    jobs[0][1],
    /publication-commit-command: \$\{\{ startsWith\(inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'node scripts\/alpha-publication-commit\.mjs' \|\| '' \}\}/u,
  );
  assert.match(
    jobs[1][1],
    /publication-commit-command: BUILDCHAIN_PUBLICATION_COMMIT_PRODUCT_ROOT=\$GITHUB_WORKSPACE BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA=\$\{\{ inputs\.resume-candidate-source-sha \}\} node \.buildchain\/publication-controller\/scripts\/alpha-publication-commit\.mjs/u,
  );
});

test('promotion rehearsal rejects restored activation or passport evidence commands', () => {
  const promotionPath = CONTRACT.workflows.promotion;
  const original = fs.readFileSync(path.join(ROOT, promotionPath), 'utf8');
  for (const jobName of ['promote', 'recover']) {
    const job = extractWorkflowJob(original, jobName);
    for (const [emptyBinding, restoredBinding] of [
      [
        '      release-activation-command: ""',
        '      release-activation-command: node scripts/activate-ungfu-release.mjs',
      ],
      [
        '      release-passport-evidence-command: ""',
        '      release-passport-evidence-command: node scripts/prepare-ungfu-release-evidence.mjs',
      ],
    ]) {
      const driftedJob = job.replace(emptyBinding, restoredBinding);
      assert.notEqual(driftedJob, job, `${jobName}: ${emptyBinding}`);
      const result = validateWorkflowSources(ROOT, CONTRACT, {
        promotion: original.replace(job, driftedJob),
      });
      assert.equal(result.ok, false, `${jobName}: ${emptyBinding}`);
      assert.ok(
        result.findings.some((entry) => entry.message.includes('must leave')),
        `${jobName}: ${emptyBinding}`,
      );
    }
  }
});

test('Alpha recovery reuses a verified sealed candidate through the reviewed floating contract', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const recovery = extractWorkflowJob(workflow, 'recover');
  assert.ok(recovery);
  assert.match(
    recovery,
    new RegExp(
      `uses: kungfu-systems/buildchain/\\.github/workflows/release-candidate-promote\\.yml@${RELEASE_ADMISSION.buildchain.runtimes.alpha.ref}`,
      'u',
    ),
  );
  for (const binding of [
    'buildchain-channel: auto',
    'buildchain-ref: ${{ inputs.resume-buildchain-runtime-sha }}',
    'target-ref: ${{ inputs.target-ref }}',
    'target-sha: ${{ inputs.target-sha }}',
    'resume-candidate-repository: ${{ inputs.resume-candidate-repository }}',
    'resume-candidate-run-id: ${{ inputs.resume-candidate-run-id }}',
    'resume-expected-workflow-file: ${{ inputs.resume-expected-workflow-file }}',
    'resume-expected-workflow-name: ${{ inputs.resume-expected-workflow-name }}',
    'resume-expected-source-tree: ${{ inputs.resume-expected-source-tree }}',
    'resume-expected-candidate-runtime-sha: ${{ inputs.resume-expected-candidate-runtime-sha }}',
    'resume-buildchain-runtime-sha: ${{ inputs.resume-buildchain-runtime-sha }}',
    'resume-transaction-id: ${{ inputs.resume-transaction-id }}',
    'publication-gate-controller-sha: ${{ inputs.resume-publication-gate-controller-sha }}',
    'publish-command: node .buildchain/publication-controller/scripts/buildchain-custom-publish-evidence.mjs',
    'publish-transaction-override: ${{ inputs.publish-transaction-override }}',
    'dry-run: false',
  ]) {
    assert.ok(recovery.includes(binding), binding);
  }
  assert.doesNotMatch(recovery, /release-candidate-promote\.yml@[0-9a-f]{40}/u);
  assert.doesNotMatch(recovery, /^\s+strategy:\s*$/mu);
  assert.doesNotMatch(workflow, /test "\$CANDIDATE_RUN_ID" = "[0-9]+"/u);
  assert.doesNotMatch(workflow, /test "\$PREFLIGHT_RUN_ID" = "[0-9]+"/u);
  assert.match(workflow, /\[\[ "\$CANDIDATE_RUN_ID" =~ \^\[0-9\]\+\$ \]\]/u);
  assert.match(workflow, /\[\[ "\$PREFLIGHT_RUN_ID" =~ \^\[0-9\]\+\$ \]\]/u);
  assert.match(
    workflow,
    /candidate_run_head_sha="\$\([\s\S]*actions\/runs\/\$\{CANDIDATE_RUN_ID\}[\s\S]*\.conclusion == "success"[\s\S]*\.event == "pull_request"[\s\S]*\.path == "\.github\/workflows\/build\.yml"[\s\S]*\)"[\s\S]*git\/commits\/\$\{CANDIDATE_SOURCE_SHA\}[\s\S]*\.tree\.sha == [\s\S]*any\(\.parents\[\]; \.sha ==/u,
  );
  assert.doesNotMatch(workflow, /\.head_sha == "'"\$CANDIDATE_SOURCE_SHA"'"/u);
  assert.match(
    workflow,
    /resume-publication-gate-controller-sha must be an exact lowercase 40-character commit SHA/u,
  );
  assert.match(
    workflow,
    /actions\/runs\/\$\{PREFLIGHT_RUN_ID\}[\s\S]*\.path == "\.github\/workflows\/alpha-promotion-preflight\.yml"[\s\S]*artifact-name=alpha-promotion-preflight-\$preflight_source_sha/u,
  );
  assert.match(
    workflow,
    /working-directory: \.buildchain\/alpha-preflight-source[\s\S]*\.\/shifu alpha:promotion:preflight verify[\s\S]*--source-commit "\$PREFLIGHT_SOURCE_SHA"[\s\S]*test "\$\(git rev-parse 'HEAD\^\{tree\}'\)" = "\$EXPECTED_TREE"/u,
  );
  assert.match(
    workflow,
    /test "\$\(git rev-parse 'HEAD\^\{tree\}'\)" = "\$EXPECTED_TREE"/u,
  );
  assert.match(
    workflow,
    /\[\[ ! "\$RECOVERY_RUNTIME_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u,
  );
  assert.doesNotMatch(
    workflow,
    /test "\$RECOVERY_RUNTIME_SHA" = "[0-9a-f]{40}"/u,
  );
});

test('promotion rejects an event-scoped Buildchain runtime override', () => {
  const promotionPath = CONTRACT.workflows.promotion;
  const original = fs.readFileSync(path.join(ROOT, promotionPath), 'utf8');
  const promote = extractWorkflowJob(original, 'promote');
  const drifted = original.replace(
    promote,
    promote.replace(
      "      buildchain-ref: ${{ startsWith(inputs.target-ref || github.event.pull_request.base.ref, 'alpha/') && 'v3-alpha' || 'v3' }}",
      "      buildchain-ref: ${{ inputs.buildchain-ref || 'v3-alpha' }}",
    ),
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    promotion: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('v3-alpha or v3 floating contracts'),
    ),
  );
});

test('promotion rejects a static Buildchain ref that differs from its workflow shell', () => {
  const promotionPath = CONTRACT.workflows.promotion;
  const original = fs.readFileSync(path.join(ROOT, promotionPath), 'utf8');
  const promote = extractWorkflowJob(original, 'promote');
  const drifted = original.replace(
    promote,
    promote.replace(
      "      buildchain-ref: ${{ startsWith(inputs.target-ref || github.event.pull_request.base.ref, 'alpha/') && 'v3-alpha' || 'v3' }}",
      '      buildchain-ref: 0000000000000000000000000000000000000000',
    ),
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    promotion: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('v3-alpha or v3 floating contracts'),
    ),
  );
});

test('manual Buildchain validation retains the v3-alpha default and declared input boundary', () => {
  const buildPath = CONTRACT.workflows.build;
  const original = fs.readFileSync(path.join(ROOT, buildPath), 'utf8');
  const binding =
    "      buildchain-ref: ${{ inputs.buildchain-ref || 'v3-alpha' }}";
  const withoutDefault = original.replace(
    binding,
    '      buildchain-ref: ${{ inputs.buildchain-ref }}',
  );
  assert.notEqual(withoutDefault, original);
  const missingDefault = validateWorkflowSources(ROOT, CONTRACT, {
    build: withoutDefault,
  });
  assert.equal(missingDefault.ok, false);
  assert.ok(
    missingDefault.findings.some((entry) =>
      entry.message.includes('default to the v3-alpha runtime'),
    ),
  );

  const withoutInput = original.replace(
    / {6}buildchain-ref:\n {8}description: "Temporary Buildchain train or exact SHA for trusted manual validation"\n {8}required: false\n {8}default: ""\n/u,
    '',
  );
  assert.notEqual(withoutInput, original);
  const missingInput = validateWorkflowSources(ROOT, CONTRACT, {
    build: withoutInput,
  });
  assert.equal(missingInput.ok, false);
  assert.ok(
    missingInput.findings.some((entry) =>
      entry.message.includes('optional empty-default workflow_dispatch input'),
    ),
  );
});

test('candidate build rejects a committed exact Buildchain runtime pin', () => {
  const buildPath = CONTRACT.workflows.build;
  const original = fs.readFileSync(path.join(ROOT, buildPath), 'utf8');
  const drifted = original.replace(
    "      buildchain-ref: ${{ inputs.buildchain-ref || 'v3-alpha' }}",
    '      buildchain-ref: 733812ff9405241705f5f267fe2e5ec6351e1a2d',
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, { build: drifted });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('default to the v3-alpha runtime'),
    ),
  );
});

test('PR-stage builds reject a premature publish-source lock', () => {
  const buildPath = CONTRACT.workflows.build;
  const original = fs.readFileSync(path.join(ROOT, buildPath), 'utf8');
  const buildchainRef =
    "      buildchain-ref: ${{ inputs.buildchain-ref || 'v3-alpha' }}";
  const drifted = original.replace(
    buildchainRef,
    [
      buildchainRef,
      "      publish-source-ref: ${{ github.head_ref || '' }}",
    ].join('\n'),
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, { build: drifted });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes(
        'leave publish-source locking to exact manual Release Cut recovery',
      ),
    ),
  );
});

test('release builds retain the bounded large-repository GitHub fallback window', () => {
  const buildPath = CONTRACT.workflows.build;
  const original = fs.readFileSync(path.join(ROOT, buildPath), 'utf8');
  const drifted = original.replaceAll(
    '      checkout-cache-github-timeout-seconds: 1200',
    '      checkout-cache-github-timeout-seconds: 600',
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, { build: drifted });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('bounded large-repository GitHub fallback window'),
    ),
  );
});

test('release qualification rejects ADR admission before Episode evidence', () => {
  const qualification = fs.readFileSync(
    path.join(ROOT, 'scripts/run-release-qualification.mjs'),
    'utf8',
  );
  const drifted = qualification.replace(
    "'episode:qualify:release'",
    "'episode:qualification:missing'",
  );
  assert.notEqual(drifted, qualification);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    qualification: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('qualify Episodes before ADR release admission'),
    ),
  );
});

test('promotion preflight owns no release credentials or side-effect commands', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const preflight = extractWorkflowJob(workflow, 'promotion-contract');
  assert.ok(preflight);
  assert.doesNotMatch(preflight, /^\s+secrets:/m);
  for (const command of CONTRACT.safety.forbidden_commands) {
    assert.equal(preflight.includes(command), false, command);
  }
});

describe('Git-sensitive promotion rehearsals', { concurrency: false }, () => {
  test('the full rehearsal preserves tracked files and the current worktree HEAD', () => {
    const result = runRehearsal({ root: ROOT });
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.equal(result.side_effects.tracked_files_changed, false);
    assert.equal(result.side_effects.refs_changed, false);
    assert.equal(result.side_effects.remote_mutations_attempted, false);
    assert.equal(result.side_effects.promotion_credentials_consumed, false);
  });

  test('a non-promotion GitHub event does not become ADR admission', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ action: 'workflow_dispatch', inputs: {} }),
    );
    try {
      const result = runRehearsal({ root: ROOT, eventPath });
      assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
      assert.equal(result.event, null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an intermediate Release Cut PR does not become ADR admission', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: { ref: 'fix/alpha2-lineage-repair-r16' },
          head: { ref: 'fix/alpha2-r16-recovery-identity' },
        },
      }),
    );
    try {
      const result = runRehearsal({ root: ROOT, eventPath });
      assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
      assert.equal(result.event, null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an actual GitHub promotion event traverses the ADR gate CLI', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: { ref: 'alpha/v4/v4.0', sha: head },
          head: { ref: 'dev/v4/v4.0', sha: head },
          html_url: 'https://github.com/kungfu-systems/kungfu/pull/999903',
          body: `<!-- kungfu-adr-release:v1\n${JSON.stringify({
            schema: 'kungfu.adr-release-pr/v1',
            kind: 'alpha-settlement',
            no_adr_progress_reason:
              'Synthetic no-delta promotion proves the immutable event path',
          })}\n-->`,
        },
      }),
    );
    try {
      const result = runRehearsal({ root: ROOT, eventPath });
      assert.equal(result.ok, true, result.event?.output);
      assert.equal(result.event?.report?.mode, 'alpha');
      assert.equal(result.event?.report?.ok, true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an actual stable event fails closed on the current ADR balance sheet', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: { ref: 'release/v4/v4.0', sha: head },
          head: { ref: 'alpha/v4/v4.0', sha: head },
          html_url: 'https://github.com/kungfu-systems/kungfu/pull/999904',
          body: `<!-- kungfu-adr-release:v1\n${JSON.stringify({
            schema: 'kungfu.adr-release-pr/v1',
            kind: 'stable-admission',
            release: '4.0.0',
          })}\n-->`,
        },
      }),
    );
    try {
      const result = runRehearsal({ root: ROOT, eventPath });
      assert.equal(result.ok, false);
      assert.equal(result.event?.report?.mode, 'stable');
      assert.equal(result.event?.report?.ok, false);
      assert.ok(result.event?.report?.summary.blocked > 0);
      assert.ok(result.findings.some((entry) => entry.code === 'event'));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
