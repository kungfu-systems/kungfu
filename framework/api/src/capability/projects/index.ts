// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { WorkStartReceipt } from '../agent-work-lab.js';
import type { ProductSearchDocument } from '../product-search.js';

export type ProjectFileTreeEntry = {
  relativePath: string;
  absolutePath: string;
  name: string;
  depth: number;
  kind: 'directory' | 'file' | 'link';
  collapsed: boolean;
  expandable: boolean;
};

export type ProjectFileTreeOptions = {
  expandedPaths?: ReadonlySet<string>;
  maxDepth?: number;
  maxEntries?: number;
};

const COLLAPSED_PROJECT_DIRECTORIES = new Set([
  '.git',
  '.kungfu',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
]);

export function readProjectFileTree(
  root: string,
  {
    expandedPaths = new Set<string>(),
    maxDepth = 6,
    maxEntries = 80,
  }: ProjectFileTreeOptions = {},
): ProjectFileTreeEntry[] {
  const entries: ProjectFileTreeEntry[] = [];

  const visit = (directory: string, depth: number) => {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => {
      const leftDirectory = left.isDirectory() ? 0 : 1;
      const rightDirectory = right.isDirectory() ? 0 : 1;
      return (
        leftDirectory - rightDirectory ||
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    });
    for (const child of children) {
      if (entries.length >= maxEntries) return;
      const relativePath = path.relative(
        root,
        path.join(directory, child.name),
      );
      const directoryEntry = child.isDirectory();
      const expandable =
        directoryEntry &&
        !COLLAPSED_PROJECT_DIRECTORIES.has(child.name) &&
        depth < maxDepth;
      const collapsed =
        directoryEntry && (!expandable || !expandedPaths.has(relativePath));
      entries.push({
        relativePath,
        absolutePath: path.resolve(root, relativePath),
        name: child.name,
        depth,
        kind: directoryEntry
          ? 'directory'
          : child.isSymbolicLink()
            ? 'link'
            : 'file',
        collapsed,
        expandable,
      });
      if (directoryEntry && !collapsed) {
        visit(path.join(directory, child.name), depth + 1);
      }
    }
  };

  visit(root, 0);
  return entries;
}

export function toggleProjectFileTreeEntry(
  expandedPaths: ReadonlySet<string>,
  entry: ProjectFileTreeEntry,
): Set<string> {
  const next = new Set(expandedPaths);
  if (entry.kind !== 'directory' || !entry.expandable) return next;
  if (entry.collapsed) {
    next.add(entry.relativePath);
    return next;
  }
  for (const candidate of next) {
    if (
      candidate === entry.relativePath ||
      candidate.startsWith(`${entry.relativePath}${path.sep}`)
    ) {
      next.delete(candidate);
    }
  }
  return next;
}

export function projectFileTreeParentIndex(
  entries: ProjectFileTreeEntry[],
  selected: number,
): number {
  const entry = entries[selected];
  if (!entry || entry.depth === 0) return Math.max(0, selected);
  for (let index = selected - 1; index >= 0; index -= 1) {
    if (entries[index]?.depth === entry.depth - 1) return index;
  }
  return Math.max(0, selected);
}

export function projectFileTreeLabel(entry: ProjectFileTreeEntry): string {
  const prefix = '  '.repeat(entry.depth);
  if (entry.kind === 'directory') {
    return `${prefix}${entry.collapsed ? '▸' : '▾'} ${entry.name}/`;
  }
  return `${prefix}${entry.kind === 'link' ? '↗' : '·'} ${entry.name}`;
}

export type ProjectSummary = {
  schema: 'kungfu.project/v1';
  id: string;
  name: string;
  path: string;
  available: boolean;
  selected: boolean;
  initialized: boolean;
  state: string;
  identityRoot?: string;
  source?: 'library' | 'recent' | 'workspace-catalog';
};

export type ProjectsCatalog = {
  schema: 'kungfu.projects.catalog/v1';
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  registryPath: string;
  libraryPath: string;
  sources: Record<string, number>;
  hiddenProjectCount: number;
  writeOccurred: false;
  catalogRoot: string;
};

export type ProjectTemplateSummary = {
  id: string;
  version: string;
  title: string;
  description: string;
  suggestedDirectoryName: string;
  sourcePath: string;
  templateRoot: string;
  initialWorkTitle: string | null;
};

export type ProjectsTemplates = {
  schema: 'kungfu.projects.templates/v1';
  templates: ProjectTemplateSummary[];
  writeOccurred: false;
  catalogRoot: string;
};

export type ProjectImportPlan = {
  schema: 'kungfu.project.import-plan/v1';
  project: ProjectSummary;
  effects: string[];
  skippedEffects: string[];
  confirmationRequired: true;
  writeOccurred: false;
  planRoot: string;
};

export type ProjectRemovePlan = {
  schema: 'kungfu.project.remove-plan/v1';
  project: ProjectSummary;
  effects: string[];
  skippedEffects: string[];
  confirmationRequired: true;
  writeOccurred: false;
  planRoot: string;
};

export type ProjectRemoveReceipt = {
  schema: 'kungfu.project.remove-receipt/v1';
  status: 'removed';
  planRoot: string;
  project: ProjectSummary;
  registryPath: string;
  selectedProjectId: string | null;
  projectFilesChanged: false;
  projectDirectoryDeleted: false;
  writeOccurred: true;
  receiptRoot: string;
};

export type ProjectCommandOptions = {
  bin: string;
  env: Record<string, string | undefined>;
  execFile: (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      maxBuffer: number;
    },
  ) => Promise<string>;
  execFileInput?: (
    file: string,
    args: string[],
    input: string,
    options: {
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      maxBuffer: number;
    },
  ) => Promise<string>;
  execFileEvents?: (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      maxBuffer: number;
    },
    onLine: (line: string) => void,
  ) => Promise<void>;
};

export type ProjectWorkRunEvent = {
  schema: 'kungfu.work-start.event/v1';
  index: number;
  stage: string;
  status: string;
  text: string;
  root: string | null;
  activity?: {
    kind?: 'agent' | 'tool';
    phase?: string;
    text?: string;
    commandPreview?: string;
  };
};

export type ProjectWorkRunReceipt = WorkStartReceipt;

export type ProjectWorkCapturePlan = {
  schema: 'kungfu.project-work.capture-plan/v1';
  initiativeId: string;
  assignmentId: string;
  title: string;
  objective: string;
  acceptanceChecks: string[];
  request: {
    schema: 'kungfu.assignment-request/v1';
    source: {
      kind: 'kungfu-product';
      surface: 'project-work-composer';
    };
    retention: {
      policy: 'explicit-expiry-retain-bytes-v1';
      expiresAt: null;
    };
    workDefinition: {
      goal_id: string;
      mission_id: string;
      title: string;
      objective: string;
      acceptance_criteria: string[];
    };
  };
  confirmationRequired: true;
  writeOccurred: false;
};

export type ProjectWorkCaptureReceipt = {
  schema: 'kungfu.assignment-capture.response/v1';
  status: 'captured' | 'already-present';
  requestRoot: string;
  receiptRoot: string;
  requestPath: string;
  receiptPath: string;
  target: {
    workspaceId: string;
    workspaceRoot: string;
    dataHome: string;
    runtimeInitialized: boolean;
  };
  authority: 'capture-material-only';
  admitted: false;
  claimed: false;
};

export type ProjectWorkRunPlan = {
  schema: 'kungfu.work-start.plan/v1';
  planRoot: string;
  executable: boolean;
  confirmationRequired: true;
  workspace: { id: string; root: string };
  work: {
    assignmentId: string;
    title: string;
    objective: string;
    acceptanceChecks: string[];
  };
  agent: {
    id: string;
    label: string;
    provider: string;
    selection: string;
    verification: {
      ok: boolean;
      available: boolean;
      version: string | null;
      error: string | null;
    };
  };
  effects: Array<{ stage: string; label: string }>;
  skippedEffects: string[];
  admissionBinding: { ok: boolean; state: string };
  writeOccurred: false;
};

export type ProjectWorkRunSnapshot = {
  id: string;
  provider: string;
  workspace: string;
  work?: string;
  task?: string;
  startedAt: number;
  lastEventAt: number;
  running: boolean;
  events: ProjectWorkRunEvent[];
  receipt?: ProjectWorkRunReceipt;
  error?: string;
};

export type Projects = {
  list: () => Promise<ProjectsCatalog>;
  files: (
    projectPath: string,
    options?: ProjectFileTreeOptions,
  ) => ProjectFileTreeEntry[];
  templates: () => Promise<ProjectsTemplates>;
  planCreate: (
    destination?: string,
    templateId?: string,
  ) => Promise<Record<string, unknown>>;
  create: (
    destination: string,
    expectedPlanRoot: string,
    templateId?: string,
  ) => Promise<Record<string, unknown>>;
  planImport: (path: string) => Promise<ProjectImportPlan>;
  importProject: (
    path: string,
    expectedPlanRoot: string,
  ) => Promise<Record<string, unknown>>;
  select: (path: string) => Promise<Record<string, unknown>>;
  planRemove: (projectId: string) => Promise<ProjectRemovePlan>;
  remove: (
    projectId: string,
    expectedPlanRoot: string,
  ) => Promise<ProjectRemoveReceipt>;
  prepareWork: (
    objective: string,
    acceptanceCriterion: string,
  ) => ProjectWorkCapturePlan;
  captureWork: (
    workspace: string,
    plan: ProjectWorkCapturePlan,
  ) => Promise<ProjectWorkCaptureReceipt>;
  planRun: (
    provider: string,
    options?: {
      workspace?: string;
      work?: string;
      task?: string;
      expectedPlanRoot?: string;
    },
  ) => Promise<ProjectWorkRunPlan>;
  run: (
    provider: string,
    options: {
      workspace?: string;
      work?: string;
      task?: string;
      expectedPlanRoot?: string;
    },
    onEvent?: (event: ProjectWorkRunEvent) => void,
  ) => Promise<ProjectWorkRunReceipt>;
  runs: () => ProjectWorkRunSnapshot[];
  subscribeRuns: (
    listener: (runs: ProjectWorkRunSnapshot[]) => void,
  ) => () => void;
};

function parse<T>(raw: string, schema: string): T {
  const payload = JSON.parse(raw) as { schema?: string };
  if (payload.schema !== schema) {
    throw new Error(`Kungfu returned an invalid ${schema} result`);
  }
  return payload as T;
}

function projectWorkSlug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'project-work'
  );
}

export function prepareProjectWork(
  objective: string,
  acceptanceCriterion: string,
  nonce = randomUUID().replaceAll('-', '').slice(0, 8),
): ProjectWorkCapturePlan {
  const normalizedObjective = objective.trim();
  const normalizedAcceptance = acceptanceCriterion.trim();
  if (!normalizedObjective)
    throw new Error('Project Work requires a non-empty objective');
  if (!normalizedAcceptance)
    throw new Error('Project Work requires at least one acceptance criterion');
  const suffix = projectWorkSlug(nonce).slice(0, 12) || 'work';
  const initiativeId = `project-work-${suffix}`;
  const assignmentId = `assignment-${projectWorkSlug(normalizedObjective)}-${suffix}`;
  const title = (
    normalizedObjective.split(/\r?\n/u)[0] ?? normalizedObjective
  ).slice(0, 96);
  const acceptanceChecks = [
    normalizedAcceptance,
    'Validation evidence and unresolved risks are reported',
  ];
  return {
    schema: 'kungfu.project-work.capture-plan/v1',
    initiativeId,
    assignmentId,
    title,
    objective: normalizedObjective,
    acceptanceChecks,
    request: {
      schema: 'kungfu.assignment-request/v1',
      source: {
        kind: 'kungfu-product',
        surface: 'project-work-composer',
      },
      retention: {
        policy: 'explicit-expiry-retain-bytes-v1',
        expiresAt: null,
      },
      workDefinition: {
        goal_id: assignmentId,
        mission_id: initiativeId,
        title,
        objective: normalizedObjective,
        acceptance_criteria: acceptanceChecks,
      },
    },
    confirmationRequired: true,
    writeOccurred: false,
  };
}

export function projectSearchDocuments(
  catalog: ProjectsCatalog,
): ProductSearchDocument[] {
  return catalog.projects.map((project, index) => ({
    id: `project.${project.id}`,
    kind: 'project',
    title: project.name,
    summary: [
      project.path,
      project.selected ? 'Current project' : '',
      project.available ? project.state : 'Unavailable on this machine',
    ]
      .filter(Boolean)
      .join(' · '),
    section: 'Projects',
    keywords: ['project', project.path, project.state],
    priority: index,
    action: { kind: 'open-project', projectPath: project.path },
  }));
}

export function openProjects(options: ProjectCommandOptions): Projects {
  let retainedRuns: ProjectWorkRunSnapshot[] = [];
  const runListeners = new Set<(runs: ProjectWorkRunSnapshot[]) => void>();
  const publishRuns = () => {
    const snapshot = retainedRuns.map((run) => ({
      ...run,
      events: [...run.events],
    }));
    for (const listener of runListeners) listener(snapshot);
  };
  const updateRun = (
    id: string,
    update: (run: ProjectWorkRunSnapshot) => ProjectWorkRunSnapshot,
  ) => {
    retainedRuns = retainedRuns.map((run) =>
      run.id === id ? update(run) : run,
    );
    publishRuns();
  };
  const invoke = async <T>(args: string[], schema: string): Promise<T> => {
    const raw = await options.execFile(options.bin, args, {
      encoding: 'utf8',
      env: options.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parse<T>(raw, schema);
  };
  const invokeInput = async <T>(
    args: string[],
    input: string,
    schema: string,
  ): Promise<T> => {
    if (!options.execFileInput)
      throw new Error('Project Work capture input is not available');
    const raw = await options.execFileInput(options.bin, args, input, {
      encoding: 'utf8',
      env: options.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parse<T>(raw, schema);
  };
  return {
    list: () =>
      invoke<ProjectsCatalog>(
        ['project', 'list'],
        'kungfu.projects.catalog/v1',
      ),
    files: (projectPath, fileOptions) =>
      readProjectFileTree(projectPath, fileOptions),
    templates: () =>
      invoke<ProjectsTemplates>(
        ['project', 'templates'],
        'kungfu.projects.templates/v1',
      ),
    planCreate: (destination, templateId) =>
      invoke(
        [
          'project',
          'create-plan',
          ...(destination ? ['--destination', destination] : []),
          ...(templateId ? ['--template', templateId] : []),
        ],
        'kungfu.project-template.plan/v1',
      ),
    create: (destination, expectedPlanRoot, templateId) =>
      invoke(
        [
          'project',
          'create',
          destination,
          ...(templateId ? ['--template', templateId] : []),
          '--expected-plan-root',
          expectedPlanRoot,
          '--execute',
        ],
        'kungfu.project-template.creation-receipt/v1',
      ),
    planImport: (path) =>
      invoke<ProjectImportPlan>(
        ['project', 'open-plan', path],
        'kungfu.project.import-plan/v1',
      ),
    importProject: (path, expectedPlanRoot) =>
      invoke(
        [
          'project',
          'open',
          path,
          '--expected-plan-root',
          expectedPlanRoot,
          '--execute',
        ],
        'kungfu.project.import-receipt/v1',
      ),
    select: (path) =>
      invoke(
        ['project', 'select', path],
        'kungfu.project.selection-receipt/v1',
      ),
    planRemove: (projectId) =>
      invoke<ProjectRemovePlan>(
        ['project', 'remove-plan', projectId],
        'kungfu.project.remove-plan/v1',
      ),
    remove: (projectId, expectedPlanRoot) =>
      invoke<ProjectRemoveReceipt>(
        [
          'project',
          'remove',
          projectId,
          '--expected-plan-root',
          expectedPlanRoot,
          '--execute',
        ],
        'kungfu.project.remove-receipt/v1',
      ),
    prepareWork: (objective, acceptanceCriterion) =>
      prepareProjectWork(objective, acceptanceCriterion),
    captureWork: (workspace, plan) =>
      invokeInput<ProjectWorkCaptureReceipt>(
        [
          'work',
          'capture',
          '--request',
          '-',
          '--workspace',
          workspace,
          '--json',
        ],
        JSON.stringify(plan.request),
        'kungfu.assignment-capture.response/v1',
      ),
    planRun: (provider, commandOptions = {}) =>
      invoke<ProjectWorkRunPlan>(
        [
          'run',
          provider,
          ...(commandOptions.task ? [commandOptions.task] : []),
          ...(commandOptions.workspace
            ? ['--workspace', commandOptions.workspace]
            : []),
          ...(commandOptions.work ? ['--work', commandOptions.work] : []),
          ...(commandOptions.expectedPlanRoot
            ? ['--expected-plan-root', commandOptions.expectedPlanRoot]
            : []),
          '--plan',
        ],
        'kungfu.work-start.plan/v1',
      ),
    run: async (provider, commandOptions, onEvent) => {
      const startedAt = Date.now();
      const runId = [
        provider,
        commandOptions.workspace ?? 'current',
        commandOptions.work ?? commandOptions.task ?? 'next',
        String(startedAt),
      ].join(':');
      retainedRuns = [
        {
          id: runId,
          provider,
          workspace: commandOptions.workspace ?? '',
          work: commandOptions.work,
          task: commandOptions.task,
          startedAt,
          lastEventAt: startedAt,
          running: true,
          events: [],
        },
        ...retainedRuns,
      ].slice(0, 8);
      publishRuns();
      const args = [
        'run',
        provider,
        ...(commandOptions.task ? [commandOptions.task] : []),
        ...(commandOptions.workspace
          ? ['--workspace', commandOptions.workspace]
          : []),
        ...(commandOptions.work ? ['--work', commandOptions.work] : []),
        ...(commandOptions.expectedPlanRoot
          ? ['--expected-plan-root', commandOptions.expectedPlanRoot]
          : []),
      ];
      if (!onEvent || !options.execFileEvents) {
        try {
          const receipt = await invoke<ProjectWorkRunReceipt>(
            [...args, '--json'],
            'kungfu.work-start.receipt/v1',
          );
          updateRun(runId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            receipt,
          }));
          return receipt;
        } catch (reason) {
          updateRun(runId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            error: reason instanceof Error ? reason.message : String(reason),
          }));
          throw reason;
        }
      }
      let receipt: ProjectWorkRunReceipt | null = null;
      try {
        await options.execFileEvents(
          options.bin,
          [...args, '--events-json'],
          {
            encoding: 'utf8',
            env: options.env,
            maxBuffer: 64 * 1024 * 1024,
          },
          (line) => {
            const payload = JSON.parse(line) as
              | ProjectWorkRunEvent
              | ProjectWorkRunReceipt;
            if (payload.schema === 'kungfu.work-start.event/v1') {
              updateRun(runId, (run) => ({
                ...run,
                lastEventAt: Date.now(),
                events: [...run.events, payload].slice(-100),
              }));
              onEvent(payload);
            } else if (payload.schema === 'kungfu.work-start.receipt/v1') {
              receipt = payload;
            }
          },
        );
        if (!receipt)
          throw new Error('Work run stream ended without a canonical receipt');
        updateRun(runId, (run) => ({
          ...run,
          running: false,
          lastEventAt: Date.now(),
          receipt: receipt ?? undefined,
        }));
        return receipt;
      } catch (reason) {
        updateRun(runId, (run) => ({
          ...run,
          running: false,
          lastEventAt: Date.now(),
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        throw reason;
      }
    },
    runs: () =>
      retainedRuns.map((run) => ({ ...run, events: [...run.events] })),
    subscribeRuns: (listener) => {
      runListeners.add(listener);
      listener(
        retainedRuns.map((run) => ({ ...run, events: [...run.events] })),
      );
      return () => runListeners.delete(listener);
    },
  };
}
