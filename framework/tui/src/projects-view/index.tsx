// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectRemovePlan,
  ProjectSummary,
  Projects,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import { Box, Text, useApp } from 'ink';
import React from 'react';

import {
  resolveListWindow,
  scrollListSelection,
} from '../list-window/index.js';
import { boundedIndex } from '../navigation.js';
import type { QuickCommand, TerminalDimensions } from '../profile-shell.js';
import {
  KUNGFU_PROJECT_DISCOVERY_PATTERN,
  TerminalLoadingScene,
} from '../profile-shell.js';
import { terminalCanvasRows } from '../terminal-canvas.js';
import { decodeTerminalMouseInput } from '../terminal-lifecycle.js';

export type ProjectWorkspaceSelection = {
  schema: 'kungfu.workspace.identity/v1';
  workspace_id: string;
  identity_root: string;
  identity_state: 'qualified' | 'locator-candidate';
  workspace_kind: 'project';
  workspace_root: string;
  display_path: string;
  data_home: string;
  runtime_dir: string;
  initialized: boolean;
  state: string;
  resolution_reason: string;
  available: boolean;
};

type ProjectSelectionReceipt = {
  project: ProjectSummary;
  workspace: ProjectWorkspaceSelection;
};

type CreatePlan = {
  templateId: string;
  destination: string;
  planRoot: string;
  effects: string[];
};

type ImportPlan = {
  project: ProjectSummary;
  planRoot: string;
  effects: string[];
  skippedEffects: string[];
};

export type ProjectsQuickAction =
  | 'project-new'
  | 'project-open'
  | 'project-remove';

export const PROJECTS_QUICK_COMMANDS: QuickCommand<ProjectsQuickAction>[] = [
  {
    id: 'project-new',
    command: '/new',
    title: 'New Project',
    summary: 'Create an ordinary Project under ~/Documents/Kungfu.',
    action: 'project-new',
  },
  {
    id: 'project-open',
    command: '/open',
    title: 'Open Project',
    summary: 'Open any existing directory without changing its files.',
    action: 'project-open',
  },
  {
    id: 'project-remove',
    command: '/remove',
    title: 'Remove Project',
    summary: 'Forget the selected locator while keeping every project file.',
    action: 'project-remove',
  },
];

export type ProjectWorkQuickAction = 'project-work-new';

export const PROJECT_WORK_QUICK_COMMANDS: QuickCommand<ProjectWorkQuickAction>[] =
  [
    {
      id: 'project-work-new',
      command: '/new',
      title: 'Create Project Work',
      summary:
        'Describe a real outcome and acceptance criterion in the open Project.',
      action: 'project-work-new',
    },
  ];

export function projectWorkQuickCommandAvailable(options: {
  surface: string;
  hasOpenedProject: boolean;
  completedWork: boolean;
}): boolean {
  return (
    options.hasOpenedProject &&
    (options.surface === 'project-work' ||
      (options.surface === 'project-assignment' && options.completedWork))
  );
}

export function selectVisibleProjectWorkRun<Run extends { workspace: string }>(
  runs: readonly Run[],
  workspace: string,
  suppressRetainedRun: boolean,
): Run | null {
  if (suppressRetainedRun) return null;
  return runs.find((candidate) => candidate.workspace === workspace) ?? null;
}

export type ProjectsActionRequest = {
  id: number;
  action: ProjectsQuickAction;
};

type ProjectsInputMode = 'browse' | 'confirmation' | 'import-path';

const BROWSE_PROJECTS_INPUT = new Map<string, string>([
  ['q', 'quit'],
  ['\u0003', 'quit'],
  ['a', 'open-lab'],
  ['r', 'refresh'],
  ['j', 'move-down'],
  ['\u001b[B', 'move-down'],
  ['k', 'move-up'],
  ['\u001b[A', 'move-up'],
  ['n', 'plan-create'],
  ['o', 'begin-import'],
  ['d', 'plan-remove'],
  ['\r', 'open-project'],
]);
const CONFIRMATION_PROJECTS_INPUT = new Map<string, string>([
  ['y', 'confirm'],
  ['\r', 'confirm'],
  ['n', 'cancel'],
  ['\u001b', 'cancel'],
]);
const IMPORT_PATH_PROJECTS_INPUT = new Map<string, string>([
  ['\u001b', 'cancel'],
  ['\r', 'confirm'],
  ['\u007f', 'delete'],
  ['\b', 'delete'],
]);
const PROJECTS_INPUT_BY_MODE = {
  browse: BROWSE_PROJECTS_INPUT,
  confirmation: CONFIRMATION_PROJECTS_INPUT,
  'import-path': IMPORT_PATH_PROJECTS_INPUT,
} satisfies Record<ProjectsInputMode, Map<string, string>>;

export function resolveProjectsInput(value: string, mode: ProjectsInputMode) {
  const action = PROJECTS_INPUT_BY_MODE[mode].get(value);
  if (action) return action;
  if (mode === 'import-path' && /^[\x20-\x7e]+$/u.test(value))
    return `append:${value}`;
  return 'none';
}

export function ProjectsHost({
  projects,
  dimensions,
  isInputCaptured,
  onOpenProject,
  onOpenLab,
  onSearchDocuments,
  onInputModeChange,
  onWorkspacePointer,
  openedProject,
  actionRequest,
  onActionHandled,
}: {
  projects: Projects;
  dimensions: {
    get: () => TerminalDimensions;
    subscribe: (
      listener: (dimensions: TerminalDimensions) => void,
    ) => () => void;
  };
  isInputCaptured: () => boolean;
  onOpenProject: (selection: ProjectWorkspaceSelection) => void;
  onOpenLab: () => void;
  onSearchDocuments: (catalog: ProjectsCatalog) => void;
  onInputModeChange: (active: boolean) => void;
  onWorkspacePointer: () => void;
  openedProject?: ProjectWorkspaceSelection;
  actionRequest?: ProjectsActionRequest;
  onActionHandled?: (id: number) => void;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [catalog, setCatalog] = React.useState<ProjectsCatalog>();
  const [selected, setSelected] = React.useState(0);
  const [busy, setBusy] = React.useState(true);
  const [message, setMessage] = React.useState('Loading Projects…');
  const [createPlan, setCreatePlan] = React.useState<CreatePlan>();
  const [importPath, setImportPath] = React.useState<string>();
  const [importPlan, setImportPlan] = React.useState<ImportPlan>();
  const [removePlan, setRemovePlan] = React.useState<ProjectRemovePlan>();
  const onSearchDocumentsRef = React.useRef(onSearchDocuments);
  React.useEffect(() => {
    onSearchDocumentsRef.current = onSearchDocuments;
  }, [onSearchDocuments]);

  const runProjectAction = React.useCallback(
    <Result,>(
      message: string,
      operation: () => Promise<Result>,
      onSuccess: (result: Result) => void | Promise<void>,
    ) => {
      setBusy(true);
      setMessage(message);
      return operation()
        .then(onSuccess)
        .catch((error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusy(false));
    },
    [],
  );
  const refresh = React.useCallback(() => {
    return runProjectAction(
      'Refreshing machine-local project locators…',
      () => projects.list(),
      (result) => {
        setCatalog(result);
        onSearchDocumentsRef.current(result);
        setSelected((current) =>
          Math.min(current, Math.max(0, result.projects.length - 1)),
        );
        setMessage(
          result.projects.length > 0
            ? `${result.projects.length} project${
                result.projects.length === 1 ? '' : 's'
              } available`
            : 'No Projects yet · create one or open an existing directory',
        );
      },
    );
  }, [projects, runProjectAction]);

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  const inputModeActive =
    importPath !== undefined ||
    Boolean(importPlan) ||
    Boolean(removePlan) ||
    Boolean(createPlan);
  React.useEffect(() => {
    onInputModeChange(inputModeActive);
    return () => onInputModeChange(false);
  }, [inputModeActive, onInputModeChange]);
  const planProject = React.useCallback(() => {
    void runProjectAction(
      'Planning a new Project under ~/Documents/Kungfu…',
      () => projects.planCreate(undefined, 'kungfu.blank-project'),
      (plan) => setCreatePlan(plan as unknown as CreatePlan),
    );
  }, [projects, runProjectAction]);
  const beginImport = React.useCallback(() => {
    setImportPath('');
    setMessage('Type an existing project directory and press Enter.');
  }, []);
  const planSelectedRemoval = React.useCallback(() => {
    const project = catalog?.projects[selected];
    if (!project) {
      setMessage('Select a Project before removing it from Kungfu.');
      return;
    }
    void runProjectAction(
      `Planning removal of ${project.name} from Kungfu…`,
      () => projects.planRemove(project.id),
      setRemovePlan,
    );
  }, [catalog, projects, runProjectAction, selected]);
  React.useEffect(() => {
    if (!actionRequest) return;
    if (actionRequest.action === 'project-new') {
      planProject();
    } else if (actionRequest.action === 'project-open') {
      beginImport();
    } else {
      planSelectedRemoval();
    }
    onActionHandled?.(actionRequest.id);
  }, [
    actionRequest,
    beginImport,
    onActionHandled,
    planProject,
    planSelectedRemoval,
  ]);
  React.useEffect(() => {
    const handleProjectsInput = (chunk: Buffer | string) => {
      const value = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(value);
      if (mouseEvents.length > 0) {
        if (!inputModeActive) {
          for (const event of mouseEvents) {
            if (
              event.kind !== 'wheel' ||
              event.column < 1 ||
              event.column > size.columns ||
              event.row < 2 ||
              event.row > terminalCanvasRows(size.rows) + 1
            ) {
              continue;
            }
            const delta = event.button === 'wheel-up' ? -1 : 1;
            setSelected((current) =>
              scrollListSelection({
                current,
                delta,
                itemCount: catalog?.projects.length ?? 0,
              }),
            );
            onWorkspacePointer();
          }
        }
        return;
      }
      if (isInputCaptured()) return;
      const mode: ProjectsInputMode =
        importPath !== undefined
          ? 'import-path'
          : importPlan || removePlan || createPlan
            ? 'confirmation'
            : 'browse';
      const intent = resolveProjectsInput(value, mode);
      if (intent === 'none') return;
      if (intent === 'cancel') {
        if (importPath !== undefined) setImportPath(undefined);
        else if (importPlan) setImportPlan(undefined);
        else if (removePlan) setRemovePlan(undefined);
        else setCreatePlan(undefined);
        setMessage(
          importPath !== undefined || importPlan
            ? 'Open Project cancelled; nothing changed.'
            : removePlan
              ? 'Project removal cancelled; no locator changed.'
              : createPlan
                ? 'Project creation cancelled; no files were written.'
                : 'Open Project cancelled; nothing changed.',
        );
        return;
      }
      if (intent === 'delete')
        return setImportPath((current) => current?.slice(0, -1) ?? '');
      if (intent.startsWith('append:'))
        return setImportPath((current) => `${current ?? ''}${intent.slice(7)}`);
      if (intent === 'confirm') {
        const path = importPath?.trim();
        if (importPath !== undefined) {
          if (!path) return;
          return runProjectAction(
            'Inspecting the existing project without changing it…',
            () => projects.planImport(path),
            (plan) => {
              setImportPath(undefined);
              setImportPlan(plan);
            },
          );
        }
        if (importPlan)
          return runProjectAction(
            'Retaining the machine-local project locator…',
            () =>
              projects.importProject(
                importPlan.project.path,
                importPlan.planRoot,
              ),
            (receipt) => {
              setImportPlan(undefined);
              onOpenProject(
                (receipt as unknown as ProjectSelectionReceipt).workspace,
              );
            },
          );
        if (removePlan)
          return runProjectAction(
            `Removing ${removePlan.project.name} from Kungfu…`,
            () => projects.remove(removePlan.project.id, removePlan.planRoot),
            async () => {
              setRemovePlan(undefined);
              setMessage(
                `${removePlan.project.name} was removed from Kungfu. Its files remain untouched.`,
              );
              await refresh();
            },
          );
        if (!createPlan) return;
        return runProjectAction(
          'Creating the Project and its local Kungfu instructions…',
          () =>
            projects.create(
              createPlan.destination,
              createPlan.planRoot,
              createPlan.templateId,
            ),
          (receipt) => {
            setCreatePlan(undefined);
            onOpenProject((receipt as ProjectSelectionReceipt).workspace);
          },
        );
      }
      if (intent === 'quit') return exit();
      if (intent === 'open-lab') return onOpenLab();
      if (intent === 'refresh') return refresh();
      if (intent === 'move-down' || intent === 'move-up')
        return setSelected((current) =>
          boundedIndex(
            current,
            intent === 'move-down' ? 1 : -1,
            catalog?.projects.length ?? 0,
          ),
        );
      if (intent === 'plan-create') return planProject();
      if (intent === 'begin-import') return beginImport();
      if (intent === 'plan-remove') return planSelectedRemoval();
      const project = catalog?.projects[selected];
      if (!project?.available) {
        setMessage('This project is unavailable on this machine.');
        return;
      }
      runProjectAction(
        `Opening ${project.name}…`,
        () => projects.select(project.path),
        (receipt) => {
          const workspace = (receipt as ProjectSelectionReceipt).workspace;
          setMessage(`${project.name} is open. Loading its Work…`);
          onOpenProject(workspace);
        },
      );
    };
    process.stdin.on('data', handleProjectsInput);
    return () => {
      process.stdin.off('data', handleProjectsInput);
    };
  }, [
    catalog,
    beginImport,
    createPlan,
    exit,
    importPath,
    importPlan,
    inputModeActive,
    isInputCaptured,
    onOpenLab,
    onOpenProject,
    onWorkspacePointer,
    planProject,
    planSelectedRemoval,
    projects,
    refresh,
    removePlan,
    runProjectAction,
    selected,
    size,
  ]);

  const visibleRows = Math.max(3, terminalCanvasRows(size.rows) - 10);
  const projectWindow = resolveListWindow({
    selected,
    itemCount: catalog?.projects.length ?? 0,
    viewportRows: visibleRows,
  });
  const rows =
    catalog?.projects.slice(projectWindow.start, projectWindow.end) ?? [];
  if (
    busy &&
    !catalog &&
    importPath === undefined &&
    !importPlan &&
    !removePlan &&
    !createPlan
  ) {
    return (
      <TerminalLoadingScene
        dimensions={{
          ...size,
          rows: terminalCanvasRows(size.rows),
        }}
        title="PROJECTS"
        status="Discovering machine-local Projects"
        detail="Joining the active instance with known Project locators."
        pattern={KUNGFU_PROJECT_DISCOVERY_PATTERN}
      />
    );
  }
  return (
    <Box
      width={size.columns}
      height={terminalCanvasRows(size.rows)}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        PROJECTS
      </Text>
      <Text>
        A Project is where Work happens and where an Agent runs. Create one or
        open any existing directory.
      </Text>
      <Text dimColor>
        [Enter] open selected · [n or /new] New Project · [o or /open] Open
        Project · [d] remove
      </Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {catalog && catalog.projects.length > rows.length ? (
          <Text dimColor>
            showing {projectWindow.start + 1}–{projectWindow.end} of{' '}
            {catalog.projects.length}
          </Text>
        ) : null}
        {rows.length === 0 ? (
          <Text color="yellow">
            No project locators have been retained yet.
          </Text>
        ) : null}
        {rows.map((project, offset) => {
          const index = projectWindow.start + offset;
          return (
            <Text
              key={project.id}
              color={index === selected ? 'cyan' : undefined}
              bold={index === selected}
              wrap="truncate-end"
            >
              {index === selected ? '›' : ' '} {project.name}{' '}
              <Text color={project.available ? 'green' : 'red'}>
                [{project.available ? project.state : 'unavailable'}]
              </Text>
              {project.selected ? <Text color="magenta"> current</Text> : null}
              {' · '}
              <Text dimColor>{project.path}</Text>
            </Text>
          );
        })}
      </Box>
      {importPath !== undefined ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold color="cyan">
            OPEN PROJECT
          </Text>
          <Text>
            Path: <Text inverse>{importPath || ' '}</Text>
          </Text>
          <Text dimColor>
            Kungfu will inspect first; it will not create .kungfu or change
            project files.
          </Text>
          <Text bold>[Enter] inspect · [Esc] cancel</Text>
        </Box>
      ) : importPlan ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="yellow"
          paddingX={1}
        >
          <Text bold color="yellow">
            OPEN THIS PROJECT?
          </Text>
          <Text>{importPlan.project.path}</Text>
          {importPlan.effects.map((effect) => (
            <Text key={effect}>• {effect}</Text>
          ))}
          <Text dimColor>No file inside the project will be changed.</Text>
          <Text bold>[y/Enter] open · [n/Esc] cancel</Text>
        </Box>
      ) : createPlan ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="yellow"
          paddingX={1}
        >
          <Text bold color="yellow">
            CREATE PROJECT?
          </Text>
          <Text>{createPlan.destination}</Text>
          {createPlan.effects.map((effect) => (
            <Text key={effect}>• {effect}</Text>
          ))}
          <Text bold>[y/Enter] create · [n/Esc] cancel</Text>
        </Box>
      ) : removePlan ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="red"
          paddingX={1}
        >
          <Text bold color="red">
            REMOVE {removePlan.project.name} FROM KUNGFU?
          </Text>
          <Text>{removePlan.project.path}</Text>
          <Text dimColor>
            Only the machine-local locator is removed. Project files and
            retained Kungfu evidence stay untouched.
          </Text>
          <Text bold>[y/Enter] remove · [n/Esc] cancel</Text>
        </Box>
      ) : (
        <>
          <Text color={busy ? 'yellow' : undefined}>
            {busy ? '◌ ' : '✓ '}
            {message}
          </Text>
          {openedProject && !busy ? (
            <Text dimColor wrap="truncate-end">
              Current · {openedProject.display_path}
            </Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
