// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentRuntimeCatalog } from '../agent-runtime.js';
import type { AgentSession } from '../agent-session.js';
import type {
  ProjectWork,
  ProjectWorkResume,
  WorkClosePlan,
  WorkCloseReceipt,
  WorkReviewEvent,
  WorkReviewPlan,
  WorkReviewReceipt,
  WorkStartReceipt,
} from '../agent-work-lab.js';
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

export type ProjectFilePreview = {
  schema: 'kungfu.project-file.preview/v1';
  projectPath: string;
  relativePath: string;
  absolutePath: string;
  name: string;
  mediaType: 'text/markdown' | 'text/plain' | 'application/json';
  language: string;
  content: string;
  size: number;
  readOnly: true;
  writeOccurred: false;
};

const PROJECT_FILE_PREVIEW_LIMIT = 512 * 1024;
const PROJECT_FILE_PREVIEW_TYPES = new Map<string, [string, string]>([
  ['.md', ['text/markdown', 'markdown']],
  ['.markdown', ['text/markdown', 'markdown']],
  ['.txt', ['text/plain', 'text']],
  ['.json', ['application/json', 'json']],
  ['.yaml', ['text/plain', 'yaml']],
  ['.yml', ['text/plain', 'yaml']],
  ['.toml', ['text/plain', 'toml']],
  ['.csv', ['text/plain', 'csv']],
  ['.tsv', ['text/plain', 'tsv']],
  ['.js', ['text/plain', 'javascript']],
  ['.jsx', ['text/plain', 'javascript']],
  ['.mjs', ['text/plain', 'javascript']],
  ['.cjs', ['text/plain', 'javascript']],
  ['.ts', ['text/plain', 'typescript']],
  ['.tsx', ['text/plain', 'typescript']],
  ['.py', ['text/plain', 'python']],
  ['.rs', ['text/plain', 'rust']],
  ['.go', ['text/plain', 'go']],
  ['.c', ['text/plain', 'c']],
  ['.cc', ['text/plain', 'cpp']],
  ['.cpp', ['text/plain', 'cpp']],
  ['.h', ['text/plain', 'c']],
  ['.hpp', ['text/plain', 'cpp']],
  ['.sh', ['text/plain', 'shell']],
  ['.bash', ['text/plain', 'shell']],
  ['.zsh', ['text/plain', 'shell']],
  ['.css', ['text/plain', 'css']],
  ['.html', ['text/plain', 'html']],
  ['.xml', ['text/plain', 'xml']],
  ['.sql', ['text/plain', 'sql']],
  ['.ini', ['text/plain', 'ini']],
  ['.conf', ['text/plain', 'text']],
]);

function isWithinProject(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

export function readProjectFilePreview(
  projectPath: string,
  relativePath: string,
): ProjectFilePreview {
  const root = fs.realpathSync(projectPath);
  const requested = path.resolve(root, relativePath);
  if (!isWithinProject(root, requested)) {
    throw new Error('Project file preview path must stay inside the Project');
  }
  const requestedStat = fs.lstatSync(requested);
  if (requestedStat.isSymbolicLink()) {
    throw new Error('Symbolic links cannot be previewed');
  }
  const absolutePath = fs.realpathSync(requested);
  if (!isWithinProject(root, absolutePath)) {
    throw new Error('Project file preview path resolves outside the Project');
  }
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile())
    throw new Error('Only regular Project files can be previewed');
  if (stat.size > PROJECT_FILE_PREVIEW_LIMIT) {
    throw new Error('Project file is larger than the 512 KiB preview limit');
  }
  const extension = path.extname(absolutePath).toLowerCase();
  const previewType = PROJECT_FILE_PREVIEW_TYPES.get(extension);
  if (!previewType) {
    throw new Error('This Project file type is not available for preview');
  }
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.includes(0))
    throw new Error('Binary Project files cannot be previewed');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Project file is not valid UTF-8 text');
  }
  const [mediaType, language] = previewType;
  return {
    schema: 'kungfu.project-file.preview/v1',
    projectPath: root,
    relativePath: path.relative(root, absolutePath),
    absolutePath,
    name: path.basename(absolutePath),
    mediaType: mediaType as ProjectFilePreview['mediaType'],
    language,
    content,
    size: stat.size,
    readOnly: true,
    writeOccurred: false,
  };
}

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
  workCount?: number;
  updatedAt?: string;
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

export type ProjectWorkInventory = {
  schema: 'kungfu.project-work.inventory/v1';
  projectPath: string;
  works: ProjectWork[];
  activeWork: ProjectWork | null;
  writeOccurred: false;
  inventoryRoot: string;
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
  catalogConfigHomes?: string[];
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
  agentSession?: AgentSession | null;
  agentSessionClient?: 'gui' | 'cli';
};

export function mergeProjectsCatalogs(
  catalogs: ProjectsCatalog[],
): ProjectsCatalog {
  const [primary, ...additional] = catalogs;
  if (!primary) {
    throw new Error('at least one Project catalog is required');
  }
  if (additional.length === 0) return primary;

  const projects: ProjectSummary[] = [];
  const seen = new Set<string>();
  for (const catalog of catalogs) {
    for (const project of catalog.projects) {
      const key = path.resolve(project.path);
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({
        ...project,
        selected: project.id === primary.selectedProjectId,
      });
    }
  }
  const sources: Record<string, number> = {};
  for (const project of projects) {
    if (!project.source) continue;
    sources[project.source] = (sources[project.source] ?? 0) + 1;
  }
  const rootInput = {
    schema: 'kungfu.projects.merged-catalog-root/v1',
    catalogRoots: catalogs.map((catalog) => catalog.catalogRoot).sort(),
    projects: projects.map((project) => ({
      id: project.id,
      path: project.path,
      available: project.available,
      state: project.state,
    })),
    selectedProjectId: primary.selectedProjectId,
  };
  return {
    ...primary,
    projects,
    sources,
    hiddenProjectCount: catalogs.reduce(
      (total, catalog) => total + (catalog.hiddenProjectCount ?? 0),
      0,
    ),
    catalogRoot: `sha256:${createHash('sha256')
      .update(JSON.stringify(rootInput))
      .digest('hex')}`,
  };
}

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
  blockedReason: string | null;
  confirmationRequired: true;
  workspace: { id: string; root: string };
  work: {
    assignmentId: string;
    title: string;
    objective: string;
    acceptanceChecks: string[];
    phase: string;
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
    projectTrust: {
      schema: 'kungfu.agent-project-trust/v1';
      provider: 'codex';
      workspaceRoot: string;
      scope: 'single-invocation';
      allows: [
        'project-local-config',
        'project-local-hooks',
        'project-local-exec-policies',
      ];
      persistent: false;
    } | null;
  };
  effects: Array<{ stage: string; label: string }>;
  skippedEffects: string[];
  admissionBinding: { ok: boolean; state: string };
  writeOccurred: false;
};

export type ProjectWorkRunSnapshot = {
  id: string;
  kind?: 'run' | 'review';
  sourceRunId?: string;
  provider: string;
  workspace: string;
  work?: string;
  task?: string;
  startedAt: number;
  lastEventAt: number;
  running: boolean;
  events: Array<ProjectWorkRunEvent | WorkReviewEvent>;
  receipt?: ProjectWorkRunReceipt;
  reviewReceipt?: WorkReviewReceipt;
  session?: ProjectAgentSessionSnapshot;
  error?: string;
};

export type ProjectAgentSessionRef = {
  workConsoleId: string;
  sessionAttemptId: string;
};

export type ProjectAgentAttention = {
  kind: 'needs-answer' | 'needs-approval' | 'blocked' | 'ready-for-review';
  reason: string;
  message: string;
  nextActions: string[];
};

export type ProjectNativeWorkSnapshot = {
  state: string;
  initiativeId: string;
  assignmentId: string;
  title: string;
  objective: string;
  acceptanceChecks: string[];
  phase: string | null;
  queryProofRoot: string | null;
  nextActions: string[];
  evidenceEpisodeRoots: string[];
  continuation: {
    completionClaimCount: number;
    independentReviewCount: number;
    continuationDecisionCount: number;
  };
  remainingObligation: string | null;
  nextAction: string | null;
};

export type ProjectAgentSessionSnapshot = ProjectAgentSessionRef & {
  provider: string;
  backend: string;
  live: boolean;
  terminalObservable: boolean;
  controllable: boolean;
  lifecycleState: string;
  interactionState: string;
  attempt: string;
  attention: ProjectAgentAttention | null;
  pendingControl: { requestId: string | number } | null;
  terminalLines: string[];
  bootstrap: {
    state: 'pending' | 'verified' | 'degraded';
    attemptId: string;
    receiptRoot: string | null;
    mutationsAllowed: boolean;
  } | null;
  nativeObserver: {
    state: string;
    ageMs: number;
    staleAfterMs: number;
    diagnostic: string | null;
    detailDiagnostic: string | null;
    workProjection: {
      state: string;
      observedAt: number;
      source: string;
      queryCount: number;
      queryProofRoot: string | null;
      diagnostic: string | null;
    } | null;
    work: ProjectNativeWorkSnapshot | null;
  } | null;
  receiptRoots: string[];
  updatedAt: number;
};

export type Projects = {
  list: (options?: { refresh?: boolean }) => Promise<ProjectsCatalog>;
  cachedCatalog: () => ProjectsCatalog | undefined;
  files: (
    projectPath: string,
    options?: ProjectFileTreeOptions,
  ) => ProjectFileTreeEntry[];
  previewFile: (
    projectPath: string,
    relativePath: string,
  ) => ProjectFilePreview;
  templates: () => Promise<ProjectsTemplates>;
  works: (projectPath: string) => Promise<ProjectWorkInventory>;
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
      scenario?: string;
      expectedPlanRoot?: string;
    },
  ) => Promise<ProjectWorkRunPlan>;
  run: (
    provider: string,
    options: {
      workspace?: string;
      work?: string;
      task?: string;
      scenario?: string;
      expectedPlanRoot?: string;
    },
    onEvent?: (event: ProjectWorkRunEvent) => void,
  ) => Promise<ProjectWorkRunReceipt>;
  resumeRun: (
    workspace: string,
    work: Pick<ProjectWork, 'initiativeId' | 'assignmentId'>,
  ) => Promise<ProjectWorkRunSnapshot | null>;
  planClose: (
    workspace: string,
    work: Pick<ProjectWork, 'initiativeId' | 'assignmentId'>,
  ) => Promise<WorkClosePlan>;
  close: (plan: WorkClosePlan) => Promise<WorkCloseReceipt>;
  planReview: (
    runId: string,
    reviewerProfileId?: string,
  ) => Promise<WorkReviewPlan>;
  review: (
    runId: string,
    plan: WorkReviewPlan,
    onEvent?: (event: WorkReviewEvent) => void,
  ) => Promise<WorkReviewReceipt>;
  runs: () => ProjectWorkRunSnapshot[];
  subscribeRuns: (
    listener: (runs: ProjectWorkRunSnapshot[]) => void,
  ) => () => void;
  syncSessions: (options?: {
    workspace?: string;
    workspaceId?: string;
    work?: string;
  }) => Promise<ProjectWorkRunSnapshot[]>;
  restoreRun: (
    receipt: ProjectWorkRunReceipt,
    workspace: string,
  ) => Promise<ProjectWorkRunSnapshot>;
  refreshRun: (runId: string) => Promise<ProjectWorkRunSnapshot | null>;
  replyToRun: (runId: string, text: string) => Promise<ProjectWorkRunSnapshot>;
  approveRun: (
    runId: string,
    approved: boolean,
  ) => Promise<ProjectWorkRunSnapshot>;
  endRun: (runId: string) => Promise<ProjectWorkRunSnapshot>;
};

type ProjectAgentSessionFinalization = {
  schema: 'kungfu.work-start.agent-session-finalization/v1';
  status: 'agent-finished';
  reportPath: string;
  agentReport: Record<string, unknown>;
  writeOccurred: true;
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
  let cachedCatalog: ProjectsCatalog | undefined;
  let catalogRequest: Promise<ProjectsCatalog> | undefined;
  const catalogConfigHomeByProjectId = new Map<string, string | undefined>();
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
  const sessionInvoke = async (
    request: Record<string, unknown> & { operation: string },
  ): Promise<Record<string, unknown>> => {
    if (!options.agentSession) {
      throw new Error('Agent Session control is unavailable on this surface');
    }
    return options.agentSession.invoke(request);
  };
  const sessionRef = (run: ProjectWorkRunSnapshot): ProjectAgentSessionRef => {
    const retained = run.session;
    const reportSession = (
      run.receipt?.agentReport as
        | { session?: Record<string, unknown> | null }
        | undefined
    )?.session;
    const workConsoleId =
      retained?.workConsoleId ?? String(reportSession?.workConsoleId ?? '');
    const sessionAttemptId =
      retained?.sessionAttemptId ??
      String(reportSession?.sessionAttemptId ?? '');
    if (!workConsoleId || !sessionAttemptId) {
      throw new Error('The retained Agent run has no Session reference');
    }
    return { workConsoleId, sessionAttemptId };
  };
  const receiptHasSessionRef = (receipt: ProjectWorkRunReceipt): boolean => {
    const session = (
      receipt.agentReport as
        | { session?: Record<string, unknown> | null }
        | undefined
    )?.session;
    return Boolean(session?.workConsoleId && session?.sessionAttemptId);
  };
  const projectSessionSnapshot = async (
    ref: ProjectAgentSessionRef,
    knownStatus?: Record<string, unknown>,
    _workspace = '',
    knownWork?: ProjectNativeWorkSnapshot | null,
  ): Promise<ProjectAgentSessionSnapshot> => {
    const status =
      knownStatus ??
      (await sessionInvoke({ operation: 'status', session: { ...ref } }));
    let terminalLines: string[] = [];
    if (status.live === true && status.terminalObservable !== false) {
      const snapshot = await sessionInvoke({
        operation: 'snapshot',
        session: { ...ref },
        requestedSequence: 0,
      });
      const terminal = snapshot.terminal as
        | { vt?: { lines?: unknown[] } }
        | undefined;
      terminalLines = (terminal?.vt?.lines ?? []).map((line) => String(line));
    }
    const agent = status.workAgent as
      | {
          attempt?: string;
          attention?: ProjectAgentAttention | null;
        }
      | undefined;
    const adapter = status.providerAdapter as { provider?: string } | undefined;
    const structured = status.structuredControl as
      | { pending?: Array<{ requestId?: string | number }> }
      | undefined;
    const pending = structured?.pending?.[0];
    const receiptRoots = Array.isArray(status.receiptRoots)
      ? status.receiptRoots.map((root) => String(root))
      : [];
    const nativeObserver = status.nativeObserver as
      | {
          state?: string;
          ageMs?: number;
          staleAfterMs?: number;
          diagnostic?: string | null;
          workProjection?: {
            state?: string;
            observedAt?: number;
            source?: string;
            queryCount?: number;
            queryProofRoot?: string | null;
            diagnostic?: string | null;
          } | null;
          work?: NonNullable<
            ProjectAgentSessionSnapshot['nativeObserver']
          >['work'];
        }
      | undefined;
    const bootstrap = status.bootstrap as
      | {
          state?: 'pending' | 'verified' | 'degraded';
          attemptId?: string;
          receiptRoot?: string | null;
          mutationsAllowed?: boolean;
        }
      | undefined;
    const rawNativeWork = nativeObserver?.work;
    const nativeWork = rawNativeWork
      ? {
          ...rawNativeWork,
          title: String(rawNativeWork.title ?? knownWork?.title ?? ''),
          objective: String(
            rawNativeWork.objective ?? knownWork?.objective ?? '',
          ),
          acceptanceChecks: Array.isArray(rawNativeWork.acceptanceChecks)
            ? rawNativeWork.acceptanceChecks.map((value) => String(value))
            : [...(knownWork?.acceptanceChecks ?? [])],
        }
      : null;
    const workProjection = nativeObserver?.workProjection ?? null;
    const detailDiagnostic = workProjection?.diagnostic ?? null;
    return {
      ...ref,
      provider: adapter?.provider ?? 'agent',
      backend: String(
        status.backend ?? (nativeObserver ? 'native-interactive' : 'capsule'),
      ),
      live: status.live === true,
      terminalObservable: status.terminalObservable !== false,
      controllable: status.controllable !== false,
      lifecycleState: String(status.lifecycleState ?? 'unavailable'),
      interactionState: String(status.interactionState ?? 'unavailable'),
      attempt: String(agent?.attempt ?? 'working'),
      attention: agent?.attention ?? null,
      pendingControl:
        pending?.requestId === undefined
          ? null
          : { requestId: pending.requestId },
      terminalLines,
      bootstrap: bootstrap?.state
        ? {
            state: bootstrap.state,
            attemptId: String(bootstrap.attemptId ?? ref.sessionAttemptId),
            receiptRoot: bootstrap.receiptRoot ?? null,
            mutationsAllowed: bootstrap.mutationsAllowed === true,
          }
        : null,
      nativeObserver: nativeObserver
        ? {
            state: String(nativeObserver.state ?? 'unknown'),
            ageMs: Number(nativeObserver.ageMs ?? 0),
            staleAfterMs: Number(nativeObserver.staleAfterMs ?? 0),
            diagnostic: nativeObserver.diagnostic ?? null,
            detailDiagnostic,
            workProjection: workProjection
              ? {
                  state: String(workProjection.state ?? 'unknown'),
                  observedAt: Number(workProjection.observedAt ?? 0),
                  source: String(workProjection.source ?? 'bounded-fallback'),
                  queryCount: Number(workProjection.queryCount ?? 0),
                  queryProofRoot: workProjection.queryProofRoot ?? null,
                  diagnostic: workProjection.diagnostic ?? null,
                }
              : null,
            work: nativeWork,
          }
        : null,
      receiptRoots,
      updatedAt: Date.now(),
    };
  };
  const refreshRun = async (
    runId: string,
  ): Promise<ProjectWorkRunSnapshot | null> => {
    const run = retainedRuns.find((candidate) => candidate.id === runId);
    if (!run) return null;
    const session = await projectSessionSnapshot(
      sessionRef(run),
      undefined,
      run.workspace,
      run.session?.nativeObserver?.work,
    );
    updateRun(runId, (current) => ({
      ...current,
      lastEventAt: session.updatedAt,
      session,
    }));
    return retainedRuns.find((candidate) => candidate.id === runId) ?? null;
  };
  const controlActorId = 'kungfu-project-work';
  const ensureProjectWorkControl = async (
    ref: ProjectAgentSessionRef,
  ): Promise<void> => {
    const status = await sessionInvoke({ operation: 'status', session: ref });
    const controller = status.controller as
      | { holderId?: unknown }
      | null
      | undefined;
    if (controller?.holderId === controlActorId) return;
    const payload = {};
    const plan = await sessionInvoke({
      operation: 'plan-control',
      controlOperation: 'acquire-control',
      session: ref,
      payload,
    });
    const receipt = await sessionInvoke({
      operation: 'acquire-control',
      actorId: controlActorId,
      client: options.agentSessionClient ?? 'gui',
      plan,
      expectedPlanRoot: plan.root,
      payload,
      automatic: false,
    });
    if (!['granted', 'duplicate'].includes(String(receipt.status))) {
      throw new Error(
        `Agent Session control is unavailable: ${String(receipt.reason ?? receipt.status ?? 'controller lease denied')}`,
      );
    }
  };
  const controlRun = async (
    runId: string,
    operation: 'instruct' | 'send-key' | 'respond-control' | 'end',
    payload: Record<string, unknown>,
    automatic = true,
  ): Promise<ProjectWorkRunSnapshot> => {
    const run = retainedRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Agent run '${runId}' is unavailable`);
    if (run.session?.controllable === false) {
      throw new Error(
        'This native Agent Session is observer-only; continue in the provider terminal',
      );
    }
    const ref = sessionRef(run);
    await ensureProjectWorkControl(ref);
    const plan = await sessionInvoke({
      operation: 'plan-control',
      controlOperation: operation,
      session: { ...ref },
      payload,
    });
    await sessionInvoke({
      operation,
      actorId: controlActorId,
      client: options.agentSessionClient ?? 'gui',
      plan,
      expectedPlanRoot: plan.root,
      payload,
      automatic,
    });
    const refreshed = await refreshRun(runId);
    if (!refreshed)
      throw new Error(`Agent run '${runId}' disappeared after control`);
    return refreshed;
  };
  const invoke = async <T>(
    args: string[],
    schema: string,
    env = options.env,
  ): Promise<T> => {
    const raw = await options.execFile(options.bin, args, {
      encoding: 'utf8',
      env,
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
  const executionReceipt = (runId: string): ProjectWorkRunReceipt => {
    const run = retainedRuns.find((candidate) => candidate.id === runId);
    if (!run?.receipt) {
      throw new Error('Independent review requires one retained Agent run');
    }
    return run.receipt;
  };
  const restoreRun = async (
    receipt: ProjectWorkRunReceipt,
    workspace: string,
  ): Promise<ProjectWorkRunSnapshot> => {
    const report = receipt.agentReport as
      | { runId?: string; session?: Record<string, unknown> | null }
      | undefined;
    const retained = report?.session;
    const attemptId = String(
      retained?.sessionAttemptId ?? report?.runId ?? receipt.receiptRoot,
    );
    const runId = `retained:${attemptId}`;
    const existing = retainedRuns.find(
      (run) =>
        run.id === runId ||
        (run.receipt?.receiptRoot &&
          run.receipt.receiptRoot === receipt.receiptRoot),
    );
    if (!existing) {
      const now = Date.now();
      const provider = String(receipt.agent?.provider ?? 'agent');
      retainedRuns = [
        {
          id: runId,
          provider: provider === 'synthetic' ? 'mock' : provider,
          workspace,
          work: String(receipt.work?.assignmentId ?? ''),
          startedAt: now,
          lastEventAt: now,
          running: false,
          events: [],
          receipt,
        },
        ...retainedRuns,
      ].slice(0, 8);
      publishRuns();
    }
    const current =
      retainedRuns.find(
        (run) =>
          run.id === runId || run.receipt?.receiptRoot === receipt.receiptRoot,
      ) ?? null;
    if (!current) throw new Error('Retained Agent run could not be restored');
    if (retained?.workConsoleId && options.agentSession) {
      return (await refreshRun(current.id)) ?? current;
    }
    return current;
  };
  const restoreReviewRun = (
    receipt: WorkReviewReceipt,
    sourceRun: ProjectWorkRunSnapshot,
  ): ProjectWorkRunSnapshot => {
    const reviewId = `retained-review:${receipt.receiptRoot}`;
    const existing = retainedRuns.find(
      (run) =>
        run.id === reviewId ||
        run.reviewReceipt?.receiptRoot === receipt.receiptRoot,
    );
    if (existing) return existing;
    const now = Date.now();
    const restored: ProjectWorkRunSnapshot = {
      id: reviewId,
      kind: 'review',
      sourceRunId: sourceRun.id,
      provider: sourceRun.provider,
      workspace: sourceRun.workspace,
      work: sourceRun.work,
      startedAt: now,
      lastEventAt: now,
      running: false,
      events: [],
      reviewReceipt: receipt,
    };
    retainedRuns = [restored, ...retainedRuns].slice(0, 8);
    publishRuns();
    return restored;
  };
  const reportPath = (receipt: ProjectWorkRunReceipt): string => {
    const report = receipt.agentReport as
      | { episode?: { reportPath?: unknown } }
      | undefined;
    const value = report?.episode?.reportPath;
    if (typeof value !== 'string' || !value) {
      throw new Error('The retained Agent run has no reviewable report path');
    }
    return value;
  };
  const preferredReviewerProfile = async (
    receipt: ProjectWorkRunReceipt,
  ): Promise<{ id: string }> => {
    const executed = receipt.agent as
      | { id?: unknown; provider?: unknown; label?: unknown }
      | undefined;
    if (
      executed?.provider === 'codex' &&
      typeof executed.id === 'string' &&
      executed.id
    ) {
      return { id: executed.id };
    }
    const catalog = await invoke<AgentRuntimeCatalog>(
      ['agent', 'runtime', 'discover', '--json'],
      'kungfu.agent-runtime-catalog/v1',
    );
    const candidates = [
      ...catalog.configured,
      ...catalog.discovered.map((row) => row.profile),
    ].filter((profile) => profile.provider === 'codex');
    const preferredIds = new Set(
      [catalog.defaultProfileId, catalog.recommendedProfileId].filter(Boolean),
    );
    const selected =
      candidates.find((profile) => preferredIds.has(profile.id)) ??
      candidates[0];
    if (!selected) {
      throw new Error(
        'Independent review requires one verified Codex runtime profile',
      );
    }
    return selected;
  };
  const invalidateCatalog = () => {
    cachedCatalog = undefined;
    catalogRequest = undefined;
  };
  const loadCatalog = (refresh = false): Promise<ProjectsCatalog> => {
    if (refresh) invalidateCatalog();
    if (cachedCatalog) return Promise.resolve(cachedCatalog);
    if (catalogRequest) return catalogRequest;
    const configHomes = [undefined, ...(options.catalogConfigHomes ?? [])];
    catalogRequest = Promise.all([
      invoke<ProjectsCatalog>(
        ['project', 'list'],
        'kungfu.projects.catalog/v1',
      ),
      ...(options.catalogConfigHomes ?? []).map((configHome) =>
        invoke<ProjectsCatalog>(
          ['project', 'list'],
          'kungfu.projects.catalog/v1',
          { ...options.env, KF_CONFIG_HOME: configHome },
        ),
      ),
    ])
      .then((catalogs) => {
        catalogConfigHomeByProjectId.clear();
        for (const [index, catalog] of catalogs.entries()) {
          for (const project of catalog.projects) {
            if (!catalogConfigHomeByProjectId.has(project.id)) {
              catalogConfigHomeByProjectId.set(project.id, configHomes[index]);
            }
          }
        }
        cachedCatalog = mergeProjectsCatalogs(catalogs);
        return cachedCatalog;
      })
      .finally(() => {
        catalogRequest = undefined;
      });
    return catalogRequest;
  };
  return {
    list: ({ refresh = false } = {}) => loadCatalog(refresh),
    cachedCatalog: () => cachedCatalog,
    files: (projectPath, fileOptions) =>
      readProjectFileTree(projectPath, fileOptions),
    previewFile: (projectPath, relativePath) =>
      readProjectFilePreview(projectPath, relativePath),
    templates: () =>
      invoke<ProjectsTemplates>(
        ['project', 'templates'],
        'kungfu.projects.templates/v1',
      ),
    works: (projectPath) =>
      invoke<ProjectWorkInventory>(
        ['project', 'works', projectPath],
        'kungfu.project-work.inventory/v1',
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
    create: async (destination, expectedPlanRoot, templateId) => {
      const receipt = await invoke<Record<string, unknown>>(
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
      );
      invalidateCatalog();
      return receipt;
    },
    planImport: (path) =>
      invoke<ProjectImportPlan>(
        ['project', 'open-plan', path],
        'kungfu.project.import-plan/v1',
      ),
    importProject: async (path, expectedPlanRoot) => {
      const receipt = await invoke<Record<string, unknown>>(
        [
          'project',
          'open',
          path,
          '--expected-plan-root',
          expectedPlanRoot,
          '--execute',
        ],
        'kungfu.project.import-receipt/v1',
      );
      invalidateCatalog();
      return receipt;
    },
    select: async (path) => {
      const receipt = await invoke<Record<string, unknown>>(
        ['project', 'select', path],
        'kungfu.project.selection-receipt/v1',
      );
      invalidateCatalog();
      return receipt;
    },
    planRemove: (projectId) =>
      invoke<ProjectRemovePlan>(
        ['project', 'remove-plan', projectId],
        'kungfu.project.remove-plan/v1',
        catalogConfigHomeByProjectId.get(projectId)
          ? {
              ...options.env,
              KF_CONFIG_HOME: catalogConfigHomeByProjectId.get(projectId),
            }
          : options.env,
      ),
    remove: async (projectId, expectedPlanRoot) => {
      const receipt = await invoke<ProjectRemoveReceipt>(
        [
          'project',
          'remove',
          projectId,
          '--expected-plan-root',
          expectedPlanRoot,
          '--execute',
        ],
        'kungfu.project.remove-receipt/v1',
        catalogConfigHomeByProjectId.get(projectId)
          ? {
              ...options.env,
              KF_CONFIG_HOME: catalogConfigHomeByProjectId.get(projectId),
            }
          : options.env,
      );
      invalidateCatalog();
      return receipt;
    },
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
          ...(commandOptions.scenario
            ? ['--scenario', commandOptions.scenario]
            : []),
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
        ...(commandOptions.scenario
          ? ['--scenario', commandOptions.scenario]
          : []),
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
          if (options.agentSession && receiptHasSessionRef(receipt)) {
            await refreshRun(runId);
          }
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
        const finalReceipt = receipt as ProjectWorkRunReceipt;
        updateRun(runId, (run) => ({
          ...run,
          running: false,
          lastEventAt: Date.now(),
          receipt: finalReceipt,
        }));
        if (options.agentSession && receiptHasSessionRef(finalReceipt)) {
          await refreshRun(runId);
        }
        return finalReceipt;
      } catch (reason) {
        const retainedFailure = receipt as ProjectWorkRunReceipt | null;
        if (retainedFailure?.status === 'agent-failed') {
          const failedReceipt = retainedFailure;
          updateRun(runId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            receipt: failedReceipt,
          }));
          if (options.agentSession && receiptHasSessionRef(failedReceipt)) {
            await refreshRun(runId);
          }
          return failedReceipt;
        }
        if (retainedFailure) {
          throw new Error(
            `${retainedFailure.status}${retainedFailure.failedAt ? ` at ${retainedFailure.failedAt}` : ''}: ${retainedFailure.message ?? 'Work start failed'}`,
          );
        }
        updateRun(runId, (run) => ({
          ...run,
          running: false,
          lastEventAt: Date.now(),
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        throw reason;
      }
    },
    resumeRun: async (workspace, work) => {
      await invoke<{
        schema: 'kungfu.work.resume-prepare/v1';
        status: 'ready' | 'reconciled';
        writeOccurred: boolean;
      }>(
        [
          'work',
          'resume-prepare',
          '--workspace',
          workspace,
          '--actor',
          'kungfu-product-project-resume',
          '--execute',
        ],
        'kungfu.work.resume-prepare/v1',
      );
      const resumed = await invoke<{
        schema: 'kungfu.work-start.resume/v1';
        status: 'retained-agent-run' | 'no-retained-agent-run';
        workReceipt: ProjectWorkResume['workReceipt'] | null;
        writeOccurred: false;
      }>(
        [
          'work',
          'start-resume',
          '--workspace',
          workspace,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
        ],
        'kungfu.work-start.resume/v1',
      );
      const closeState = await invoke<{
        schema: 'kungfu.work-close.resume/v1';
        status: 'completed' | 'close-pending' | 'review-passed' | 'not-ready';
        reviewReceipt: WorkReviewReceipt | null;
        writeOccurred: false;
      }>(
        [
          'work',
          'close-resume',
          '--workspace',
          workspace,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
        ],
        'kungfu.work-close.resume/v1',
      );
      if (!resumed.workReceipt) return null;
      const sourceRun = await restoreRun(resumed.workReceipt, workspace);
      return closeState.reviewReceipt
        ? restoreReviewRun(closeState.reviewReceipt, sourceRun)
        : sourceRun;
    },
    planClose: async (workspace, work) => {
      await invoke<{
        schema: 'kungfu.work.resume-prepare/v1';
        status: 'ready' | 'reconciled';
        writeOccurred: boolean;
      }>(
        [
          'work',
          'resume-prepare',
          '--workspace',
          workspace,
          '--actor',
          'kungfu-product-project-close',
          '--execute',
        ],
        'kungfu.work.resume-prepare/v1',
      );
      return invoke<WorkClosePlan>(
        [
          'work',
          'close-plan',
          '--workspace',
          workspace,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
        ],
        'kungfu.work-close.plan/v1',
      );
    },
    close: (plan) =>
      invoke<WorkCloseReceipt>(
        [
          'work',
          'close',
          '--workspace',
          plan.workspace.root,
          '--initiative-id',
          plan.work.initiativeId,
          '--assignment-id',
          plan.work.assignmentId,
          '--actor',
          'local-user',
          '--expected-plan-root',
          plan.planRoot,
          '--execute',
        ],
        'kungfu.work-close.receipt/v1',
      ),
    planReview: async (runId, reviewerProfileId) => {
      const receipt = executionReceipt(runId);
      const workspaceRoot = receipt.workspace?.workspace_root;
      const work = receipt.work;
      if (!workspaceRoot || !work?.initiativeId || !work.assignmentId) {
        throw new Error(
          'The retained Agent run has no exact Project Work coordinates',
        );
      }
      await invoke<{
        schema: 'kungfu.work.resume-prepare/v1';
        status: 'ready' | 'reconciled';
        writeOccurred: boolean;
      }>(
        [
          'work',
          'resume-prepare',
          '--workspace',
          workspaceRoot,
          '--actor',
          'kungfu-product-project-review',
          '--execute',
        ],
        'kungfu.work.resume-prepare/v1',
      );
      const reviewer = reviewerProfileId
        ? { id: reviewerProfileId }
        : await preferredReviewerProfile(receipt);
      return invoke<WorkReviewPlan>(
        [
          'work',
          'review-agent-plan',
          reportPath(receipt),
          '--workspace',
          workspaceRoot,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
          '--reviewer',
          reviewer.id,
        ],
        'kungfu.work-review.plan/v1',
      );
    },
    review: async (runId, plan, onEvent) => {
      const priorReviews = retainedRuns.filter(
        (run) => run.kind === 'review' && run.sourceRunId === runId,
      );
      if (priorReviews.some((run) => run.running)) {
        throw new Error('Independent review is already running');
      }
      const passedReview = priorReviews.find(
        (run) => run.reviewReceipt?.status === 'review-passed',
      );
      if (passedReview?.reviewReceipt) return passedReview.reviewReceipt;
      const receipt = executionReceipt(runId);
      const startedAt = Date.now();
      const reviewId = [
        'review',
        plan.reviewer.provider,
        plan.work.assignmentId,
        String(startedAt),
      ].join(':');
      const reviewRun: ProjectWorkRunSnapshot = {
        id: reviewId,
        kind: 'review',
        sourceRunId: runId,
        provider: plan.reviewer.provider,
        workspace: plan.workspace.root,
        work: plan.work.assignmentId,
        startedAt,
        lastEventAt: startedAt,
        running: true,
        events: [],
      };
      retainedRuns = [reviewRun, ...retainedRuns].slice(0, 8);
      publishRuns();
      const args = [
        'work',
        'review-agent-run',
        reportPath(receipt),
        '--workspace',
        plan.workspace.root,
        '--initiative-id',
        plan.work.initiativeId,
        '--assignment-id',
        plan.work.assignmentId,
        '--reviewer',
        plan.reviewer.id,
        '--expected-plan-root',
        plan.planRoot,
        '--execute',
      ];
      if (!onEvent || !options.execFileEvents) {
        try {
          const reviewReceipt = await invoke<WorkReviewReceipt>(
            [...args, '--json'],
            'kungfu.work-review.receipt/v1',
          );
          updateRun(reviewId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            reviewReceipt,
          }));
          return reviewReceipt;
        } catch (reason) {
          updateRun(reviewId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            error: reason instanceof Error ? reason.message : String(reason),
          }));
          throw reason;
        }
      }
      let reviewReceipt: WorkReviewReceipt | null = null;
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
              | WorkReviewEvent
              | WorkReviewReceipt;
            if (payload.schema === 'kungfu.work-review.event/v1') {
              updateRun(reviewId, (run) => ({
                ...run,
                lastEventAt: Date.now(),
                events: [...run.events, payload].slice(-100),
              }));
              onEvent(payload);
            } else if (payload.schema === 'kungfu.work-review.receipt/v1') {
              reviewReceipt = payload;
            }
          },
        );
        if (!reviewReceipt) {
          throw new Error(
            'Independent review stream ended without a canonical receipt',
          );
        }
        const finalReceipt = reviewReceipt as WorkReviewReceipt;
        updateRun(reviewId, (run) => ({
          ...run,
          running: false,
          lastEventAt: Date.now(),
          reviewReceipt: finalReceipt,
        }));
        return finalReceipt;
      } catch (reason) {
        const retained = reviewReceipt as WorkReviewReceipt | null;
        if (retained) {
          updateRun(reviewId, (run) => ({
            ...run,
            running: false,
            lastEventAt: Date.now(),
            reviewReceipt: retained,
          }));
          return retained;
        }
        updateRun(reviewId, (run) => ({
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
    syncSessions: async (syncOptions = {}) => {
      if (!options.agentSession) return retainedRuns;
      const listed = await sessionInvoke({ operation: 'list' });
      const sessions = Array.isArray(listed.sessions)
        ? (listed.sessions as Record<string, unknown>[])
        : [];
      const attempts = Array.isArray(listed.attempts)
        ? (listed.attempts as Record<string, unknown>[])
        : [];
      const candidates = new Map<string, Record<string, unknown>>();
      for (const status of [...attempts, ...sessions]) {
        const key = `${String(status.workConsoleId ?? '')}\u0000${String(status.sessionAttemptId ?? '')}`;
        if (key !== '\u0000') candidates.set(key, status);
      }
      for (const status of candidates.values()) {
        const binding = status.binding as
          | { kind?: string; workRef?: Record<string, unknown> }
          | undefined;
        const workRef = binding?.workRef;
        if (binding?.kind === 'work' && workRef) {
          if (
            syncOptions.workspaceId &&
            workRef.workspaceId !== syncOptions.workspaceId
          )
            continue;
          if (syncOptions.work && workRef.entityId !== syncOptions.work)
            continue;
        } else if (binding?.kind === 'workspace-assistant') {
          if (
            syncOptions.workspaceId &&
            status.workspaceId !== syncOptions.workspaceId
          )
            continue;
          if (syncOptions.work) continue;
        } else {
          continue;
        }
        const ref = {
          workConsoleId: String(status.workConsoleId ?? ''),
          sessionAttemptId: String(status.sessionAttemptId ?? ''),
        };
        if (!ref.workConsoleId || !ref.sessionAttemptId) continue;
        const existing = retainedRuns.find(
          (run) =>
            run.session?.workConsoleId === ref.workConsoleId &&
            run.session.sessionAttemptId === ref.sessionAttemptId,
        );
        const session = await projectSessionSnapshot(
          ref,
          status,
          status.lifecycleState === 'ended' ? '' : syncOptions.workspace,
          existing?.session?.nativeObserver?.work,
        );
        if (existing) {
          retainedRuns = retainedRuns.map((run) =>
            run.id === existing.id ? { ...run, session } : run,
          );
          continue;
        }
        const now = Date.now();
        retainedRuns = [
          {
            id: `session:${ref.sessionAttemptId}`,
            provider: session.provider,
            workspace: syncOptions.workspace ?? '',
            ...(workRef ? { work: String(workRef.entityId ?? '') } : {}),
            startedAt: now,
            lastEventAt: now,
            running: false,
            events: [],
            session,
          },
          ...retainedRuns,
        ].slice(0, 8);
      }
      publishRuns();
      return retainedRuns.map((run) => ({ ...run, events: [...run.events] }));
    },
    restoreRun,
    refreshRun,
    replyToRun: (runId, text) => controlRun(runId, 'instruct', { text }, false),
    approveRun: async (runId, approved) => {
      const run = retainedRuns.find((candidate) => candidate.id === runId);
      const pending = run?.session?.pendingControl;
      if (pending) {
        return controlRun(
          runId,
          'respond-control',
          {
            requestId: pending.requestId,
            decision: approved ? 'allow' : 'deny',
          },
          false,
        );
      }
      await controlRun(runId, 'send-key', { key: approved ? 'y' : 'n' }, false);
      return controlRun(runId, 'send-key', { key: 'Enter' }, false);
    },
    endRun: async (runId) => {
      const ended = await controlRun(runId, 'end', {}, false);
      const receipt = ended.receipt;
      const report = receipt?.agentReport as
        | { episode?: { reportPath?: unknown } }
        | undefined;
      const work = receipt?.work;
      const workspace = receipt?.workspace?.workspace_root;
      if (
        !receipt ||
        typeof report?.episode?.reportPath !== 'string' ||
        !report.episode.reportPath ||
        !workspace ||
        !work?.initiativeId ||
        !work.assignmentId
      ) {
        return ended;
      }
      const finalized = await invoke<ProjectAgentSessionFinalization>(
        [
          'work',
          'finalize-agent-session',
          report.episode.reportPath,
          '--workspace',
          workspace,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
        ],
        'kungfu.work-start.agent-session-finalization/v1',
      );
      const resumed = await invoke<{
        schema: 'kungfu.work-start.resume/v1';
        status: 'retained-agent-run' | 'no-retained-agent-run';
        workReceipt: ProjectWorkResume['workReceipt'] | null;
        writeOccurred: false;
      }>(
        [
          'work',
          'start-resume',
          '--workspace',
          workspace,
          '--initiative-id',
          work.initiativeId,
          '--assignment-id',
          work.assignmentId,
        ],
        'kungfu.work-start.resume/v1',
      );
      if (!resumed.workReceipt) {
        throw new Error(
          `Kungfu finalized ${finalized.reportPath} but did not return a canonical Work receipt`,
        );
      }
      const canonicalReceipt = resumed.workReceipt;
      updateRun(runId, (current) => ({
        ...current,
        lastEventAt: Date.now(),
        receipt: canonicalReceipt,
      }));
      return retainedRuns.find((candidate) => candidate.id === runId) ?? ended;
    },
  };
}
