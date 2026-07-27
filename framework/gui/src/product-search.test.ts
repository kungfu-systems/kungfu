// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('./renderer/src/main.tsx', import.meta.url),
  'utf8',
);
const workViewSource = readFileSync(
  new URL(
    '../../../extensions/work-dashboard/src/view/index.tsx',
    import.meta.url,
  ),
  'utf8',
);
const profileManagerSource = readFileSync(
  new URL(
    '../../../extensions/system/kfx-manager/src/view/index.tsx',
    import.meta.url,
  ),
  'utf8',
);

test('the title-bar search shares Help, Command, Work, and view sources', () => {
  assert.match(source, /SYSTEM_HELP_DOCUMENTS/);
  assert.match(source, /loadCliHelpSearchDocuments/);
  assert.match(source, /GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL/);
  assert.match(source, /globalWorkSearchDocuments/);
  assert.match(source, /workSearchDocuments/);
  assert.match(source, /viewSearchDocuments/);
  assert.match(source, /searchProductDocuments\(searchDocuments, searchText\)/);
  assert.match(source, /Search Help, Commands, Work/);
  assert.doesNotMatch(source, /Search views/);
  assert.doesNotMatch(source, /<datalist/);
});

test('Cmd or Ctrl K focuses the same search plane without executing CLI results', () => {
  assert.match(
    source,
    /event\.metaKey \|\| event\.ctrlKey[\s\S]*event\.key\.toLowerCase\(\) === 'k'/,
  );
  assert.match(source, /searchInput\.current\?\.focus\(\)/);
  assert.match(source, /result\.action\.kind === 'open-view'/);
  assert.match(source, /result\.action\.kind === 'open-work'/);
  assert.match(source, /productRoleEntry\(enabled, 'profile-view'\)/);
  assert.doesNotMatch(
    source,
    /openKfx\(profileHomeId\(profile, enabled\), \{\s*workId:/,
  );
  assert.doesNotMatch(source, /execFile\(result\.action/);
});

test('Work activation reaches the declared Work view and selects the exact result', () => {
  assert.match(source, /productRoleEntry\(enabled, 'profile-view'\)/);
  assert.match(source, /openKfx\(workView\.id, \{ workId:/);
  assert.match(workViewSource, /shell\.params\.workId\?\.trim\(\)/);
  assert.match(workViewSource, /\[shell\.params\.workId\]/);
});

test('Profile lifecycle refresh preserves the last visible projection', () => {
  assert.match(
    profileManagerSource,
    /const initialLoad = React\.useRef\(true\)/,
  );
  assert.match(
    profileManagerSource,
    /if \(initialLoad\.current\) setLoading\(true\)/,
  );
  assert.match(profileManagerSource, /initialLoad\.current = false/);
  assert.doesNotMatch(profileManagerSource, /\n {4}setLoading\(true\);\n/);
});
