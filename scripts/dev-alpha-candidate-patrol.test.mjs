// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const BUILDCHAIN_DEV_VERIFY_RUNTIME =
  '916fc84d488ae6f5af271a67487e79ecb47b9ae2';
const BUILDCHAIN_TIMEOUT_SAFE_RUNTIME =
  '58e48d73ae7fef0dd06ae02baf6d090e4da5487d';

function workflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
}

test('Dev Patrol is exact-source dispatch-only behind the qualification controller', () => {
  const source = workflow('dev-verify-patrol.yml');
  assert.doesNotMatch(source, /schedule:/u);
  assert.match(source, /source-sha:/u);
  assert.match(source, /test "\$REQUESTED_SHA" = "\$EVENT_SHA"/u);
  assert.match(
    source,
    /source-ref: \$\{\{ needs\.bind-source\.outputs\.source-sha \}\}/u,
  );
  assert.match(
    source,
    /buildchain-ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.buildchain-ref \|\| '' \}\}/u,
  );
  assert.doesNotMatch(
    source,
    /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| '[0-9a-f]{40}' \}\}/u,
  );
  assert.match(source, /checkout-cache-mode: off/u);
  assert.ok(source.includes(String.raw`"runner":"[\"ubuntu-24.04\"]"`));
  assert.ok(
    source.includes(
      String.raw`"platform":"linux","runner":"[\"ubuntu-24.04\"]","capabilities":["node","native-toolchain","product-artifacts","rust"],"environment":{"CC":"gcc-14","CXX":"g++-14"}`,
    ),
  );
  assert.ok(source.includes(String.raw`"runner":"[\"macos-15\"]"`));
  assert.ok(source.includes(String.raw`"runner":"[\"windows-2022\"]"`));
  assert.doesNotMatch(source, /gate-environment-json:[\s\S]*"CC":"gcc-14"/u);
  assert.doesNotMatch(source, /kungfu-build-v4-(?:linux|macos|windows)/u);
  const reusableRef = source.match(
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.gate-profile\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.equal(reusableRef, BUILDCHAIN_DEV_VERIFY_RUNTIME);
});

test('qualification patrol coalesces the latest Dev SHA behind release priority', () => {
  const source = workflow('dev-qualification-patrol.yml');
  const reusableRef = source.match(
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/dev-qualification-patrol\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.match(reusableRef || '', /^[0-9a-f]{40}$/u);
  assert.match(source, /workflow_run:/u);
  assert.match(source, /Alpha promotion preflight/u);
  assert.match(source, /Dev Verify Patrol/u);
  assert.match(source, /Release - New Version/u);
  assert.match(source, /Release native components/u);
  assert.match(source, /cron: "7,22,37,52 \* \* \* \*"/u);
  assert.match(
    source,
    /priority-workflows-json:[\s\S]*build\.yml[\s\S]*release-new-version\.yml[\s\S]*release-shifu\.yml/u,
  );
  assert.match(source, /max-attempts: 2/u);
  assert.match(
    source,
    /mutation-authorized: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/u,
  );
  assert.match(
    source,
    /qualification-token: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.doesNotMatch(source, /npm publish|gh release create|git tag/iu);
});

test('candidate patrol is a thin Buildchain caller with exact channel and evidence inputs', () => {
  const source = workflow('dev-alpha-candidate-patrol.yml');
  const reusableRef = source.match(
    /uses: kungfu-systems\/buildchain\/.github\/workflows\/dev-alpha-candidate-patrol\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.match(reusableRef || '', /^[0-9a-f]{40}$/u);
  assert.equal(reusableRef, BUILDCHAIN_TIMEOUT_SAFE_RUNTIME);
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
  assert.match(source, /name: Verify frozen Alpha Release Cut source lock/u);
  assert.match(source, /lock=\.buildchain\/alpha-release-cut-lock\.json/u);
  assert.match(source, /git show -s --format=%P/u);
  assert.match(source, /legacy Alpha\.2 parent projection drifted/u);
  assert.doesNotMatch(
    source,
    /test "\$\(git show -s --format=%P "\$candidate_sha"\)"/u,
  );
  assert.match(
    source,
    /needs\.release-cut-lock\.outputs\.candidate-settlement-authorized == 'true'/u,
  );
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
