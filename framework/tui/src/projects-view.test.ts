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
  assert.match(source, /Current · \{openedProject\.display_path\}/);
  assert.match(source, /wrap="truncate-end"/);
  assert.match(
    source,
    /Project files and\s+retained Kungfu evidence stay untouched/,
  );
});

test('Project modals own terminal input over the global control plane', () => {
  const projectsSource = readFileSync(
    new URL('./projects-view/index.tsx', import.meta.url),
    'utf8',
  );
  const mainSource = readFileSync(
    new URL('./main.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    projectsSource,
    /onInputModeChange: \(active: boolean\) => void/,
  );
  assert.match(
    projectsSource,
    /const inputModeActive =[\s\S]*?importPath !== undefined[\s\S]*?Boolean\(importPlan\)[\s\S]*?Boolean\(removePlan\)[\s\S]*?Boolean\(createPlan\)/,
  );
  assert.match(
    projectsSource,
    /onInputModeChange\(inputModeActive\)[\s\S]*?onInputModeChange\(false\)/,
  );
  assert.match(
    mainSource,
    /<ProjectsHost[\s\S]*?onInputModeChange=\{setWorkspaceInputActive\}/,
  );
  assert.match(mainSource, /workspaceInputActive[\s\S]*?'PROJECT INPUT'/);
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
  const workHost = source.slice(
    source.indexOf('function WorkControlHost'),
    source.indexOf('const PENDING_STARTUP'),
  );
  assert.match(workHost, /pattern=\{KUNGFU_WORK_DISCOVERY_PATTERN\}/);
  assert.match(workHost, /emptyState\s*\?\s*EMPTY_GLOBAL_WORK_SNAPSHOT/);
  assert.match(workHost, /if \(emptyState\) return undefined/);
});

test('opened Project Work offers an exact-plan Agent path and recoverable session controls', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const projectWorkSource = readFileSync(
    new URL('./work-window/index.tsx', import.meta.url),
    'utf8',
  );
  const projectWorkSessionState = readFileSync(
    new URL('./work-window/project-work-session-state.ts', import.meta.url),
    'utf8',
  );
  const projectWorkSessionView = readFileSync(
    new URL('./work-window/project-work-session-view.tsx', import.meta.url),
    'utf8',
  );
  const projectWork = projectWorkSource.slice(
    projectWorkSource.indexOf('export function ProjectWorkHost'),
  );

  assert.match(projectWork, /NEXT: \[Enter or \/new\] create Work/);
  assert.match(projectWork, /\[n or \/new\] New Work/);
  assert.match(projectWork, /\.prepareWork\(/);
  assert.match(projectWork, /\.captureWork\(/);
  assert.match(projectWork, /CONFIRM WORK CAPTURE/);
  assert.match(projectWork, /No Work is admitted and no\s*Agent\s+runs yet/);
  assert.match(projectWork, /\.planRun\(selectedProvider/);
  assert.match(projectWork, /KUNGFU_MOCK_AGENT_SCENARIO/);
  assert.match(projectWork, /expectedPlanRoot: acceptedPlan\.planRoot/);
  assert.match(projectWork, /\.subscribeRuns\(setRuns\)/);
  assert.match(projectWork, /\.syncSessions\(/);
  assert.match(projectWork, /const \[restoringRuns, setRestoringRuns\]/);
  assert.match(projectWork, /setRestoringRuns\(true\)/);
  assert.match(projectWork, /if \(active\) setRestoringRuns\(false\)/);
  assert.match(
    projectWork,
    /const workDiscoveryLoading = loadingWork \|\| restoringRuns/,
  );
  assert.match(projectWork, /ensureAgentSession\(project\.runtime_dir\)/);
  assert.match(projectWork, /\.restoreRun\(/);
  assert.match(projectWork, /\.replyToRun\(/);
  assert.match(projectWork, /\.approveRun\(/);
  assert.match(projectWork, /\.endRun\(/);
  assert.match(projectWork, /SESSION RUNNING/);
  assert.match(projectWorkSessionView, /NATIVE UI · OBSERVE ONLY/);
  assert.match(projectWorkSessionView, /Provider owns terminal input/);
  assert.match(projectWorkSessionView, /Objective ·/);
  assert.match(projectWorkSessionView, /Remaining ·/);
  assert.match(projectWorkSessionView, /Acceptance \{index \+ 1\} ·/);
  assert.match(projectWorkSessionView, /Next · \{observer\.work\.nextAction\}/);
  assert.match(projectWorkSessionView, /Work details ·/);
  assert.match(projectWorkSessionView, /WORK SNAPSHOT ·/);
  assert.match(projectWorkSessionView, /workProjection.queryCount/);
  assert.match(projectWork, /session\?\.nativeObserver \? null/);
  assert.match(projectWorkSessionState, /nativeObserverDisplayState:/);
  assert.doesNotMatch(projectWork, /transientNativeObserverAttention/);
  assert.doesNotMatch(projectWork, /startsWith\('native-observer-'\)/);
  assert.match(
    projectWorkSessionState,
    /const providerSessionActive = Boolean/,
  );
  assert.match(projectWorkSessionState, /session\.lifecycleState !== 'ended'/);
  assert.match(projectWork, /session\?\.controllable === false/);
  assert.match(
    projectWork,
    /Continue in the provider-native terminal; TUI is observer only/,
  );
  assert.match(projectWork, /receipt\.nextActions/);
  assert.match(projectWork, /<ProjectFileTreeNavigation/);
  assert.match(projectWork, /focused=\{fileTreeFocused\}/);
  assert.match(projectWork, /value === 't'/);
  assert.doesNotMatch(projectWork, /projectSection === 'files'/);
  assert.match(projectWork, /LOADING PROJECT WORK/);
  assert.match(projectWork, /<ProjectWorkDock/);
  assert.match(
    projectWorkSource,
    /function ProjectWorkDock[\s\S]*?height=\{4\}/,
  );
  assert.ok(
    projectWork.indexOf('KUNGFU_PROJECT_DISCOVERY_PATTERN') <
      projectWork.indexOf('title={`${loadingSpinner} LOADING PROJECT WORK`}'),
  );
  assert.match(
    projectWork,
    /workCount=\{workDiscoveryLoading \? undefined : projectWorkCount\}/,
  );
  assert.match(projectWorkSessionState, /const projectWorkCount = new Set\(/);
  assert.match(
    projectWorkSessionState,
    /if \(candidate\.session\?\.live\) return 3/,
  );
  assert.match(
    projectWorkSessionState,
    /candidate\.session\?\.backend === 'native-interactive'/,
  );
  assert.match(projectWork, /Observing Work · \$\{visibleWorkId\}/);
  assert.match(projectWork, /KUNGFU_EMPTY_WORK_NEBULA_PATTERN/);
  assert.match(projectWork, /<TerminalAmbientScene/);
  assert.match(projectWork, /const emptyProjectIdle =/);
  assert.match(
    projectWork,
    /\) : workDiscoveryLoading \|\| emptyProjectIdle \? null : \(/,
  );
  assert.match(
    projectWork,
    /NEXT: \[Enter\] review Project changes with a fresh Agent/,
  );
  assert.match(projectWork, /retainedAgentFinished/);
  assert.match(projectWork, /continueRetainedWork/);
  assert.match(
    projectWork,
    /continueRetainedWork[\s\S]*?projects[\s\S]*?\.refreshRun\(visibleRun\.id\)[\s\S]*?current\.session\?\.live[\s\S]*?projects\.endRun\(current\.id\)/,
  );
  assert.match(
    projectWork,
    /if \(value === '\\r' && retainedAgentReviewable\)[\s\S]*?continueRetainedWork\(\);[\s\S]*?if \(session\?\.controllable === false\) return/,
  );
  assert.match(
    projectWork,
    /attention\.kind === 'ready-for-review'[\s\S]*?'\[v\/Enter\] review changes'[\s\S]*?session\?\.controllable === false/,
  );
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
  assert.match(source, /await projects\.works\(/);
  assert.match(source, /await lab\.resumeProjectWork\(/);
  assert.match(
    source,
    /onContinueRetainedWork=\{async \(receipt\) => \{[\s\S]*?const resumed = await lab\.resumeProjectWork\([\s\S]*?setStarterWorkReceipt\(resumed\.workReceipt \?\? receipt\)/,
  );
  assert.doesNotMatch(source, /await lab\.resumeStarterProject\(\)/);
});

test('retained Project Work keeps the file tree in the left navigation', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );
  const host = source.slice(
    source.indexOf('export function StarterProjectHost'),
  );

  assert.match(host, /navigationPanel=\{/);
  assert.match(host, /<ProjectFileTreeNavigation/);
  assert.match(host, /focused=\{activeRegion === 0\}/);
  assert.match(host, /navigationWidth=\{projectNavigationWidth\(size\)\}/);
  assert.doesNotMatch(host, /projectSection === 'files'/);
});

test('Project Session discovery follows the current runtime host after Project restore', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const invokeCurrent = source.slice(
    source.indexOf('async function invokeTuiAgentSession'),
    source.indexOf('function cliEnvironment'),
  );
  const openProjects = source.slice(
    source.indexOf('function openTuiProjects'),
    source.indexOf('function ProjectFileTreeNavigation'),
  );

  assert.match(invokeCurrent, /const ready = tuiAgentSessionReady/);
  assert.match(invokeCurrent, /const host = tuiAgentSessionHost/);
  assert.match(
    invokeCurrent,
    /ready !== tuiAgentSessionReady \|\| host !== tuiAgentSessionHost/,
  );
  assert.match(
    openProjects,
    /agentSession:\s*useAgentSession[\s\S]*?invoke: invokeTuiAgentSession/,
  );
  assert.doesNotMatch(openProjects, /const agentSessionReady =/);
  assert.doesNotMatch(
    openProjects,
    /ensureTuiAgentSession\(paths\.runtimeDir\)/,
  );
  assert.match(openProjects, /bindTuiMockAgentEnvironment\(\{/);
  assert.ok(
    openProjects.indexOf('bindTuiMockAgentEnvironment') <
      openProjects.indexOf('if (!useAgentSession)'),
    'installed Mock Agent paths must be bound for normal Project Agent Session use',
  );
  assert.match(source, /return tuiChildCliEnvironment\(process\.env\)/);
});
