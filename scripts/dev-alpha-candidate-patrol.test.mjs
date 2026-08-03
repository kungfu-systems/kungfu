// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();

function workflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
}

test('Dev Patrol runs at 04:00 Asia/Shanghai with an explicit UTC contract', () => {
  const source = workflow('dev-verify-patrol.yml');
  assert.match(source, /04:00 Asia\/Shanghai/u);
  assert.match(source, /cron: "0 20 \* \* \*"/u);
  assert.doesNotMatch(source, /cron: "23 3 \* \* \*"/u);
  assert.match(
    source,
    /buildchain-ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.buildchain-ref \|\| '' \}\}/u,
  );
  assert.doesNotMatch(
    source,
    /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| '[0-9a-f]{40}' \}\}/u,
  );
});

test('candidate patrol is a thin Buildchain caller with exact channel and evidence inputs', () => {
  const source = workflow('dev-alpha-candidate-patrol.yml');
  const reusableRef = source.match(
    /uses: kungfu-systems\/buildchain\/.github\/workflows\/dev-alpha-candidate-patrol\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.match(reusableRef || '', /^[0-9a-f]{40}$/u);
  assert.equal(reusableRef, '978520e86134683f66b607bc70c2d18f623e2410');
  assert.match(
    source,
    new RegExp(
      `buildchain-ref: \\$\\{\\{ inputs\\.buildchain-ref \\|\\| '${reusableRef}' \\}\\}`,
      'u',
    ),
  );
  assert.match(
    source,
    /source-branch: \$\{\{ needs\.resolve-channels\.outputs\.source-branch \}\}/u,
  );
  assert.match(
    source,
    /target-branch: \$\{\{ needs\.resolve-channels\.outputs\.target-branch \}\}/u,
  );
  assert.match(
    source,
    /dev-workflow-path: \.github\/workflows\/dev-verify-patrol\.yml/u,
  );
  assert.match(
    source,
    /alpha-workflow-path: \.github\/workflows\/alpha-promotion-preflight\.yml/u,
  );
  assert.match(
    source,
    /settlement-authorized: \$\{\{ github\.event_name != 'workflow_dispatch'/u,
  );
  assert.match(
    source,
    /dry-run: \$\{\{ github\.event_name == 'workflow_dispatch'/u,
  );
  assert.match(source, /cron: "17,47 \* \* \* \*"/u);
  assert.match(source, /workflow_run:/u);
  assert.match(source, /Dev Verify Patrol/u);
  assert.match(source, /Alpha promotion preflight/u);
  assert.match(
    source,
    /head_branch == needs\.resolve-channels\.outputs\.source-branch/u,
  );
  assert.match(
    source,
    /pull-request-body-prefix-renderer: scripts\/adr-release-gate\.mjs/u,
  );
  assert.doesNotMatch(source, /pull-request-body-prefix: \|/u);
  assert.doesNotMatch(source, /"no_adr_progress_reason":/u);
  assert.doesNotMatch(source, /cron: "0 22 \* \* \*"/u);
  assert.match(
    source,
    /promotion-token: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.match(source, /auto-merge: true/u);
  assert.match(source, /merge-method: rebase/u);
  assert.doesNotMatch(
    source,
    /npm publish|gh release create|git tag|gh pr merge/iu,
  );
});

test('Alpha preflight keeps one unambiguous macOS codesign command', () => {
  const source = workflow('alpha-promotion-preflight.yml');
  const step =
    source.match(
      /- name: Verify macOS codesign probe is available[\s\S]*?- name: Install pinned Rust toolchain/u,
    )?.[0] || '';
  assert.equal(
    (step.match(/run: test -x "\$\(xcrun --find codesign\)"/gu) || []).length,
    1,
  );
});
