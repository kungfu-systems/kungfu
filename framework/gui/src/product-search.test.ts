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
  assert.match(
    source,
    /openWorkSurface\(\{ workId: result\.action\.workId \}\)/,
  );
  assert.match(
    source,
    /workEntry[\s\S]*openKfx\(workEntry\.id, restoredParams\)/,
  );
  assert.match(source, /openCoreWork\(restoredParams\)/);
  assert.match(workViewSource, /shell\.params\.workId\?\.trim\(\)/);
  assert.match(workViewSource, /\[shell\.params\.workId\]/);
});

test('Core Work remains a first-class shell surface without an admitted Work KFX', () => {
  assert.match(
    source,
    /coreWorkOpen \|\| activeKfx\?\.id === workEntry\?\.id[\s\S]*\? 'core-work'/,
  );
  assert.match(source, /onOpenAllWork=\{\(\) => openWorkSurface\(\)\}/);
  assert.match(
    source,
    /coreWorkOpen \? \([\s\S]*<ProjectWorkControlView projects=\{projects\} shell=\{shell\} \/>/,
  );
  assert.match(
    source,
    /coreWorkOpen[\s\S]*currentProjectName[\s\S]*'All Work'/,
  );
});

test('Projects, Lab, and workspace transitions close Core Work explicitly', () => {
  assert.match(
    source,
    /onOpenProjects=\{\(\) => \{[\s\S]*setCoreWorkOpen\(false\)[\s\S]*setProjectsOpen\(true\)/,
  );
  assert.match(
    source,
    /onOpenLab=\{\(\) => \{[\s\S]*setCoreWorkOpen\(false\)[\s\S]*setLabOpen\(true\)/,
  );
  assert.match(source, /onOpenWork=\{\(\) => openWorkSurface\(\)\}/);
});

test('All Work restores the last Project and section after other navigation', () => {
  assert.match(source, /const lastWorkParamsRef = React\.useRef/);
  assert.match(
    source,
    /const restoredParams = nextParams \?\? lastWorkParamsRef\.current/,
  );
  assert.match(source, /lastWorkParamsRef\.current = nextParams/);
  assert.match(
    source,
    /openWorkSurface\(\{ projectPath, projectSection: section \}\)/,
  );
  assert.match(workViewSource, /const projectViewMemory = new Map/);
  assert.match(workViewSource, /initialProjectMemory\?\.selectedFile/);
  assert.match(
    workViewSource,
    /projectViewMemory\.set\(projectMemoryKey, \{[\s\S]*section: projectSection,[\s\S]*selectedFile: selectedProjectFile/,
  );
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
