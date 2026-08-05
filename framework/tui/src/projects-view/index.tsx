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

export function ProjectsHost({
  projects,
  dimensions,
  isInputCaptured,
  onOpenProject,
  onOpenLab,
  onSearchDocuments,
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

  const refresh = React.useCallback(() => {
    setBusy(true);
    setMessage('Refreshing machine-local project locators…');
    return projects
      .list()
      .then((result) => {
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
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [projects]);

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  const planProject = React.useCallback(() => {
    setBusy(true);
    setMessage('Planning a new Project under ~/Documents/Kungfu…');
    void projects
      .planCreate(undefined, 'kungfu.blank-project')
      .then((plan) => setCreatePlan(plan as unknown as CreatePlan))
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [projects]);
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
    setBusy(true);
    setMessage(`Planning removal of ${project.name} from Kungfu…`);
    void projects
      .planRemove(project.id)
      .then(setRemovePlan)
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [catalog, projects, selected]);
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
    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(value);
      if (mouseEvents.length > 0) {
        if (
          importPath === undefined &&
          !importPlan &&
          !removePlan &&
          !createPlan
        ) {
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
      if (importPath !== undefined) {
        if (value === '\u001b') {
          setImportPath(undefined);
          setMessage('Open Project cancelled; nothing changed.');
        } else if (value === '\r') {
          if (!importPath.trim()) return;
          setBusy(true);
          setMessage('Inspecting the existing project without changing it…');
          void projects
            .planImport(importPath.trim())
            .then((plan) => {
              setImportPath(undefined);
              setImportPlan(plan);
            })
            .catch((error) =>
              setMessage(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setBusy(false));
        } else if (value === '\u007f' || value === '\b') {
          setImportPath((current) => current?.slice(0, -1) ?? '');
        } else if (/^[\x20-\x7e]+$/u.test(value)) {
          setImportPath((current) => `${current ?? ''}${value}`);
        }
        return;
      }
      if (importPlan) {
        if (value === 'y' || value === '\r') {
          setBusy(true);
          setMessage('Retaining the machine-local project locator…');
          void projects
            .importProject(importPlan.project.path, importPlan.planRoot)
            .then((receipt) => {
              setImportPlan(undefined);
              onOpenProject(
                (receipt as unknown as ProjectSelectionReceipt).workspace,
              );
            })
            .catch((error) =>
              setMessage(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setBusy(false));
        } else if (value === 'n' || value === '\u001b') {
          setImportPlan(undefined);
          setMessage('Open Project cancelled; nothing changed.');
        }
        return;
      }
      if (removePlan) {
        if (value === 'y' || value === '\r') {
          setBusy(true);
          setMessage(`Removing ${removePlan.project.name} from Kungfu…`);
          void projects
            .remove(removePlan.project.id, removePlan.planRoot)
            .then(() => {
              setRemovePlan(undefined);
              setMessage(
                `${removePlan.project.name} was removed from Kungfu. Its files remain untouched.`,
              );
              return refresh();
            })
            .catch((error) =>
              setMessage(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setBusy(false));
        } else if (value === 'n' || value === '\u001b') {
          setRemovePlan(undefined);
          setMessage('Project removal cancelled; no locator changed.');
        }
        return;
      }
      if (createPlan) {
        if (value === 'y' || value === '\r') {
          setBusy(true);
          setMessage('Creating the Project and its local Kungfu instructions…');
          void projects
            .create(
              createPlan.destination,
              createPlan.planRoot,
              createPlan.templateId,
            )
            .then((receipt) => {
              const selectedReceipt = receipt as ProjectSelectionReceipt;
              setCreatePlan(undefined);
              onOpenProject(selectedReceipt.workspace);
            })
            .catch((error) =>
              setMessage(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setBusy(false));
        } else if (value === 'n' || value === '\u001b') {
          setCreatePlan(undefined);
          setMessage('Project creation cancelled; no files were written.');
        }
        return;
      }
      if (value === 'q' || value === '\u0003') return exit();
      if (value === 'a') return onOpenLab();
      if (value === 'r') return refresh();
      if (value === 'j' || value === '\u001b[B') {
        setSelected((current) =>
          boundedIndex(current, 1, catalog?.projects.length ?? 0),
        );
        return;
      }
      if (value === 'k' || value === '\u001b[A') {
        setSelected((current) =>
          boundedIndex(current, -1, catalog?.projects.length ?? 0),
        );
        return;
      }
      if (value === 'n') {
        planProject();
        return;
      }
      if (value === 'o') {
        beginImport();
        return;
      }
      if (value === 'd') {
        planSelectedRemoval();
        return;
      }
      if (value !== '\r') return;
      const project = catalog?.projects[selected];
      if (!project?.available) {
        setMessage('This project is unavailable on this machine.');
        return;
      }
      setBusy(true);
      setMessage(`Opening ${project.name}…`);
      void projects
        .select(project.path)
        .then((receipt) => {
          const workspace = (receipt as ProjectSelectionReceipt).workspace;
          setMessage(`${project.name} is open. Loading its Work…`);
          onOpenProject(workspace);
        })
        .catch((error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusy(false));
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    catalog,
    beginImport,
    createPlan,
    exit,
    importPath,
    importPlan,
    isInputCaptured,
    onOpenLab,
    onOpenProject,
    onWorkspacePointer,
    planProject,
    planSelectedRemoval,
    projects,
    refresh,
    removePlan,
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
