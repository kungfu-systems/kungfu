// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Projects exposes only New, Open, and safe removal on the first layer', () => {
  const source = readFileSync(
    new URL('./projects-view/index.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /\[n or \/new\] New Project/);
  assert.match(source, /\[o or \/open\] Open\s+Project/);
  assert.match(source, /\[d\]\s+remove/);
  assert.match(source, /command: '\/new'/);
  assert.match(source, /command: '\/open'/);
  assert.match(source, /command: '\/remove'/);
  assert.match(source, /kungfu\.blank-project/);
  assert.doesNotMatch(source, /command: '\/import'/);
  assert.doesNotMatch(source, /command: '\/blank'/);
  assert.match(source, /projects\s*\.select\(project\.path\)/);
  assert.match(source, /PROJECT OPENED/);
  assert.match(
    source,
    /Project files and\s+retained Kungfu evidence stay untouched/,
  );
});

test('ordinary Project selection enters an explicit Project surface', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const openProject = source.slice(
    source.indexOf('const openProject = React.useCallback'),
    source.indexOf('const openGlobalWork = React.useCallback'),
  );

  assert.match(openProject, /setOpenedProject\(selection\)/);
  assert.match(
    openProject,
    /setControlNow\(\{\s*\.\.\.CLOSED_CONTROL_PLANE,\s*focus: 'workspace'/,
  );
  assert.match(openProject, /setSurface\('project-work'\)/);
  assert.match(openProject, /setSurface\('project-assignment'\)/);
  assert.doesNotMatch(openProject, /setSurface\('all-work'\)/);
});

test('All Work navigation preserves but does not reuse Project context', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const openGlobalWork = source.slice(
    source.indexOf('const openGlobalWork = React.useCallback'),
    source.indexOf('const activateControl = React.useCallback'),
  );

  assert.doesNotMatch(openGlobalWork, /setOpenedProject\(undefined\)/);
  assert.match(
    openGlobalWork,
    /setControlNow\(\{\s*\.\.\.CLOSED_CONTROL_PLANE,\s*focus: 'workspace'/,
  );
  assert.match(openGlobalWork, /setSurface\('all-work'\)/);
  assert.match(source, /if \(value === '1'\) openGlobalWork\(\)/);
  assert.doesNotMatch(source, /onOpenWork=\{openGlobalWork\}/);
  assert.match(source, /GlobalWorkFilter/);
  assert.match(source, /'active', 'completed', 'all'/);
  assert.match(source, /value === 'f'/);
});

test('opened Project Work offers an exact-plan Codex path and retained session output', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const projectWork = source.slice(
    source.indexOf('function ProjectWorkHost'),
    source.indexOf('const PENDING_STARTUP'),
  );

  assert.match(projectWork, /NEXT: \[Enter or \/new\] create Work/);
  assert.match(projectWork, /\[n or \/new\] New Work/);
  assert.match(projectWork, /\.prepareWork\(/);
  assert.match(projectWork, /\.captureWork\(/);
  assert.match(projectWork, /CONFIRM WORK CAPTURE/);
  assert.match(projectWork, /No Work is admitted and no\s*Agent\s+runs yet/);
  assert.match(projectWork, /\.planRun\('codex'/);
  assert.match(projectWork, /expectedPlanRoot: acceptedPlan\.planRoot/);
  assert.match(projectWork, /\.subscribeRuns\(setRuns\)/);
  assert.match(projectWork, /CODEX SESSION RUNNING/);
  assert.match(projectWork, /receipt\.nextActions/);
  assert.match(projectWork, /<ProjectFilesHost/);
  assert.match(projectWork, /value === 't'/);
  assert.match(projectWork, /LOADING PROJECT WORK/);
  assert.match(projectWork, /empty-Project state will appear only after/);
  assert.match(projectWork, /\{' {2}'\}Files/);
  assert.match(projectWork, /› Work \{loadingWork \? '…' : 0\}/);
  assert.match(
    projectWork,
    /NEXT: \[Enter\] review Project changes with a fresh Agent/,
  );
  assert.match(projectWork, /retainedAgentFinished/);
  assert.match(projectWork, /continueRetainedWork/);
  assert.doesNotMatch(
    projectWork,
    /'[^']*(?:Initiative|Assignment|Portfolio)[^']*'/,
  );
  assert.match(source, /label: openedProject[\s\S]*?`\[2\] Project ·/);
  assert.match(source, /if \(openedProject\) openHome\(\)/);
  assert.match(source, /setProjectWorkLoading\(true\)/);
  assert.match(
    source,
    /setProjectWorkLoading\(false\)[\s\S]*setProjectResumeSettled\(true\)/,
  );
  assert.match(source, /await lab\.resumeStarterProject\(\)/);
});
