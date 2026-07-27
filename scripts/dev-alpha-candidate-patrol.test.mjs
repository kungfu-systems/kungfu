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
});

test('candidate patrol is a thin Buildchain caller with exact channel and evidence inputs', () => {
  const source = workflow('dev-alpha-candidate-patrol.yml');
  const reusableRef = source.match(
    /uses: kungfu-systems\/buildchain\/.github\/workflows\/dev-alpha-candidate-patrol\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.match(reusableRef || '', /^[0-9a-f]{40}$/u);
  assert.match(
    source,
    new RegExp(
      `buildchain-ref: \\$\\{\\{ inputs\\.buildchain-ref \\|\\| '${reusableRef}' \\}\\}`,
      'u',
    ),
  );
  assert.match(source, /source-branch: dev\/v4\/v4\.0/u);
  assert.match(source, /target-branch: alpha\/v4\/v4\.0/u);
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
    /create-pull-request: \$\{\{ github\.event_name == 'schedule'/u,
  );
  assert.match(source, /dry-run: \$\{\{ github\.event_name != 'schedule'/u);
  assert.match(
    source,
    /promotion-token: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.doesNotMatch(
    source,
    /npm publish|gh release create|git tag|auto-merge/iu,
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
