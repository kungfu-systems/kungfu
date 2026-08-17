// SPDX-License-Identifier: Apache-2.0

import {
  type ProductSearchDocument,
  SYSTEM_HELP_DOCUMENTS,
} from '@kungfu-tech/api/capability';
import { boundedIndex } from './navigation.js';

export type ProductSurface =
  | 'loading'
  | 'onboarding'
  | 'lab'
  | 'all-work'
  | 'projects'
  | 'project-work'
  | 'project-assignment';

export function initialProductSurface({
  playbackMode,
  firstLaunch,
  emptyState,
  openLab = false,
}: {
  playbackMode: boolean;
  firstLaunch: boolean;
  emptyState: boolean;
  openLab?: boolean;
}): ProductSurface {
  if (playbackMode) return 'lab';
  if (openLab) return 'lab';
  if (emptyState) return 'all-work';
  return firstLaunch ? 'onboarding' : 'loading';
}

export function onboardingContinueSurface(
  firstLaunch: boolean,
): ProductSurface {
  return firstLaunch ? 'projects' : 'all-work';
}

type SearchableQuickCommand = {
  id: string;
  command: string;
  summary: string;
  title: string;
};

const TUI_PRODUCT_VIEW_DOCUMENTS: ProductSearchDocument[] = [
  {
    id: 'view.work-control',
    kind: 'view',
    title: 'All Work',
    summary: 'Open the cross-Project read-only Work overview.',
    keywords: ['all', 'work', 'active', 'completed'],
    action: { kind: 'open-view', viewId: 'work' },
  },
  {
    id: 'view.projects',
    kind: 'view',
    title: 'Projects',
    summary: 'Create a Project or open an existing directory.',
    keywords: ['project', 'new', 'open', 'directory'],
    action: { kind: 'open-view', viewId: 'projects' },
  },
  {
    id: 'view.agent-work-lab',
    kind: 'view',
    title: 'Agent Work Lab',
    summary: 'Compare bounded Agent Work behavior across two Sessions.',
    keywords: ['qualification', 'handoff', 'session'],
    action: { kind: 'open-view', viewId: 'lab' },
  },
  {
    id: 'view.onboarding',
    kind: 'view',
    title: 'Getting Started',
    summary: 'Reopen the Agent-first onboarding guide at any time.',
    keywords: ['onboarding', 'agent', 'guide', 'first'],
    action: { kind: 'open-view', viewId: 'onboarding' },
  },
];

export function buildTuiProductSearchDocuments({
  quickCommands,
  cliDocuments,
  workDocuments,
  projectDocuments,
}: {
  quickCommands: readonly SearchableQuickCommand[];
  cliDocuments: readonly ProductSearchDocument[];
  workDocuments: readonly ProductSearchDocument[];
  projectDocuments: readonly ProductSearchDocument[];
}): ProductSearchDocument[] {
  const quickSearchDocuments = quickCommands.map((command, index) => ({
    id: `command.quick.${command.id}`,
    kind: 'command' as const,
    title: command.command,
    summary: command.summary,
    section: 'Quick actions',
    keywords: [command.title],
    priority: index,
    action: {
      kind: 'describe-command' as const,
      command: command.command,
    },
  }));
  return [
    ...SYSTEM_HELP_DOCUMENTS,
    ...quickSearchDocuments,
    ...cliDocuments,
    ...workDocuments,
    ...projectDocuments,
    ...TUI_PRODUCT_VIEW_DOCUMENTS,
  ];
}

export type ControlPlaneMode =
  | 'closed'
  | 'help'
  | 'commands'
  | 'search'
  | 'detail';

export type ControlPlaneState = {
  mode: ControlPlaneMode;
  focus: 'input' | 'workspace';
  returnFocus?: 'input' | 'workspace';
  query: string;
  selected: number;
  notice?: string;
  detail?: ProductSearchDocument;
};

export type ControlPlaneBarModel = {
  acceptsText: boolean;
  glyph: '◆' | '›' | '◇';
  hint: string;
  inputFocused: boolean;
  modeLabel: string;
  prompt: string;
  tone: 'cyan' | 'gray';
};

export function controlPlaneBarModel({
  state,
  resultCount,
  controlsLabel,
  controlsHint,
  workspaceInputActive,
}: {
  state: ControlPlaneState;
  resultCount: number;
  controlsLabel: string;
  controlsHint: string;
  workspaceInputActive: boolean;
}): ControlPlaneBarModel {
  const modalOpen = state.mode !== 'closed';
  const inputFocused =
    !workspaceInputActive && (modalOpen || state.focus === 'input');
  const value =
    state.mode === 'commands' || state.mode === 'search' || !modalOpen
      ? state.query
      : '';
  const prompt = workspaceInputActive
    ? 'Focused panel accepts text'
    : state.mode === 'help'
      ? 'Help open'
      : state.mode === 'detail'
        ? 'Details open'
        : value || (!modalOpen && !inputFocused ? 'Press i to type' : '');
  const hint = workspaceInputActive
    ? controlsHint
    : (state.notice ??
      (state.mode === 'commands'
        ? `${resultCount} action${resultCount === 1 ? '' : 's'} · Enter Run · Esc Close`
        : state.mode === 'search'
          ? `${resultCount} result${resultCount === 1 ? '' : 's'} · Enter Open · Esc Close`
          : state.mode === 'help' || state.mode === 'detail'
            ? 'Esc Back'
            : state.focus === 'workspace'
              ? `${controlsHint} · i Input`
              : 'Esc Controls · ? Help · / Actions · Ctrl+K Search'));
  return {
    acceptsText:
      state.mode === 'closed' ||
      state.mode === 'commands' ||
      state.mode === 'search',
    glyph: workspaceInputActive ? '◆' : inputFocused ? '›' : '◇',
    hint,
    inputFocused,
    modeLabel: modalOpen ? state.mode.toUpperCase() : controlsLabel,
    prompt,
    tone: inputFocused || workspaceInputActive ? 'cyan' : 'gray',
  };
}

export type ControlPlaneUpdate = {
  handled: boolean;
  state: ControlPlaneState;
  activate?: boolean;
  quit?: boolean;
  workspaceNavigation?: 'next-focus';
};

export type ControlPlaneInputFence = {
  captureCurrentEmission: () => void;
  isCaptured: () => boolean;
};

export function createControlPlaneInputFence(
  isOpen: () => boolean,
): ControlPlaneInputFence {
  let capturedCurrentEmission = false;
  return {
    captureCurrentEmission: () => {
      capturedCurrentEmission = true;
      queueMicrotask(() => {
        capturedCurrentEmission = false;
      });
    },
    isCaptured: () => capturedCurrentEmission || isOpen(),
  };
}

export type QuickCommand<Action extends string = string> = {
  id: string;
  command: `/${string}`;
  title: string;
  summary: string;
  action: Action;
};

export type ProductQuickCommandAction =
  | 'help'
  | 'search'
  | 'health'
  | 'new-work'
  | 'work'
  | 'projects'
  | 'lab'
  | 'onboarding'
  | 'home'
  | 'quit';

export const QUICK_COMMANDS: QuickCommand<ProductQuickCommandAction>[] = [
  {
    id: 'help',
    command: '/help',
    title: 'Open Help',
    summary:
      'Explain the input bar, shortcuts, search sources, and safety boundary.',
    action: 'help',
  },
  {
    id: 'search',
    command: '/search',
    title: 'Search Kungfu',
    summary: 'Find Help, Commands, Work, and product views.',
    action: 'search',
  },
  {
    id: 'health',
    command: '/health',
    title: 'Inspect Health',
    summary:
      'Describe the read-only runtime, Peer, storage, and Episode health command.',
    action: 'health',
  },
  {
    id: 'new-work',
    command: '/new',
    title: 'Create Work',
    summary:
      'Create Work in the current Project, or choose a Project when none is open.',
    action: 'new-work',
  },
  {
    id: 'work',
    command: '/work',
    title: 'Open All Work',
    summary: 'Open the cross-Project read-only Work overview.',
    action: 'work',
  },
  {
    id: 'projects',
    command: '/projects',
    title: 'Open Projects',
    summary: 'Choose a Project before creating or running Project Work.',
    action: 'projects',
  },
  {
    id: 'lab',
    command: '/lab',
    title: 'Open Lab',
    summary: 'Open the installed identity-neutral work experiment suite.',
    action: 'lab',
  },
  {
    id: 'onboarding',
    command: '/onboarding',
    title: 'Open Getting Started',
    summary: 'Reopen the Agent-first onboarding guide at any time.',
    action: 'onboarding',
  },
  {
    id: 'home',
    command: '/home',
    title: 'Return to current context',
    summary:
      'Return to the selected Project, or the resolved startup surface when no Project is open.',
    action: 'home',
  },
  {
    id: 'quit',
    command: '/quit',
    title: 'Quit Kungfu',
    summary: 'Leave the TUI and restore the terminal.',
    action: 'quit',
  },
];

export const CLOSED_CONTROL_PLANE: ControlPlaneState = {
  mode: 'closed',
  focus: 'input',
  query: '',
  selected: 0,
};

export function resolveProductStartupSurface({
  contextualProject,
  openedProject,
  projectResumeSettled,
}: {
  contextualProject: boolean;
  openedProject: boolean;
  projectResumeSettled: boolean;
}): 'project-work' | 'all-work' | null {
  if (!contextualProject) return 'all-work';
  if (openedProject) return 'project-work';
  return projectResumeSettled ? 'all-work' : null;
}

export function shouldStartContextualProjectRestore({
  playbackMode,
  surface,
  emptyState,
  startupProjectRoot,
}: {
  playbackMode: boolean;
  surface: string;
  emptyState: boolean;
  startupProjectRoot?: string;
}): boolean {
  return (
    !playbackMode &&
    contextualProjectRestoreCanCommit(surface) &&
    !emptyState &&
    Boolean(startupProjectRoot)
  );
}

export function contextualProjectRestoreCanCommit(surface: string): boolean {
  return surface === 'loading';
}

export function directWorkspaceNavigationFromInput(
  current: ControlPlaneState,
  input: string,
  surface: string,
): 'projects' | null {
  if (
    current.mode === 'closed' &&
    current.focus === 'input' &&
    current.query === '' &&
    input === 'p' &&
    (surface === 'project-work' || surface === 'project-assignment')
  ) {
    return 'projects';
  }
  return null;
}

export function projectWorkOwnsInput(
  current: ControlPlaneState,
  input: string,
  surface: string,
): boolean {
  return (
    surface === 'project-work' &&
    current.mode === 'closed' &&
    current.focus === 'workspace' &&
    input === 'i'
  );
}

export function quickCommandMatches(
  query: string,
  commands: QuickCommand[] = QUICK_COMMANDS,
): QuickCommand[] {
  const needle = query.replace(/^\//, '').trim().toLocaleLowerCase();
  if (!needle) return commands;
  const prefixMatches = commands.filter(
    (command) =>
      command.command.slice(1).startsWith(needle) ||
      command.title.toLocaleLowerCase().startsWith(needle),
  );
  if (prefixMatches.length > 0) return prefixMatches;
  return commands.filter((command) =>
    `${command.command} ${command.title} ${command.summary}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

function openedControlPlane(
  mode: Exclude<ControlPlaneMode, 'closed' | 'detail'>,
  query = '',
  returnFocus: ControlPlaneState['focus'] = 'input',
): ControlPlaneState {
  return {
    mode,
    focus: 'input',
    query,
    selected: 0,
    ...(returnFocus === 'workspace' ? { returnFocus } : {}),
  };
}

function closedControlPlane(
  focus: ControlPlaneState['focus'] = 'input',
): ControlPlaneState {
  return { ...CLOSED_CONTROL_PLANE, focus };
}

export function reduceControlPlaneInput(
  current: ControlPlaneState,
  input: string,
  itemCount: number,
): ControlPlaneUpdate {
  if (input === '\u0003') {
    return { handled: true, state: current, quit: true };
  }
  if (input === '\u000b') {
    return {
      handled: true,
      state: openedControlPlane(
        'search',
        current.mode === 'closed' && current.focus === 'input'
          ? current.query
          : '',
        current.mode === 'closed'
          ? current.focus
          : (current.returnFocus ?? 'input'),
      ),
    };
  }
  if (current.mode === 'closed') {
    if (current.focus === 'workspace') {
      if (input === 'i') {
        return {
          handled: true,
          state: { ...current, focus: 'input', notice: undefined },
        };
      }
      if (input === '?') {
        return {
          handled: true,
          state: openedControlPlane('help', '', current.focus),
        };
      }
      if (input === '/') {
        return {
          handled: true,
          state: openedControlPlane('commands', '/', current.focus),
        };
      }
      return { handled: false, state: current };
    }
    if (input === '\u001b') {
      if (current.query) {
        return {
          handled: true,
          state: { ...current, query: '', notice: undefined },
        };
      }
      return {
        handled: true,
        state: { ...current, focus: 'workspace', notice: undefined },
      };
    }
    if (input === '\t' && !current.query) {
      return {
        handled: true,
        state: { ...current, focus: 'workspace', notice: undefined },
        workspaceNavigation: 'next-focus',
      };
    }
    if (input === '\u007f' || input === '\b') {
      return {
        handled: true,
        state: {
          ...current,
          query: [...current.query].slice(0, -1).join(''),
          notice: undefined,
        },
      };
    }
    if ((input === '\r' || input === '\n') && current.query) {
      return {
        handled: true,
        state: {
          ...current,
          notice:
            'Free-form Agent conversation is coming soon. Use / commands or Ctrl+K search.',
        },
      };
    }
    if (input === '?' && !current.query) {
      return {
        handled: true,
        state: openedControlPlane('help', '', current.focus),
      };
    }
    if (input === '/' && !current.query) {
      return {
        handled: true,
        state: openedControlPlane('commands', '/', current.focus),
      };
    }
    if (/^[\x20-\x7e]+$/.test(input)) {
      return {
        handled: true,
        state: {
          ...current,
          query: `${current.query}${input}`.slice(0, 160),
          notice: undefined,
        },
      };
    }
    return { handled: true, state: current };
  }
  if (input === '\u001b') {
    return {
      handled: true,
      state: closedControlPlane(current.returnFocus ?? 'input'),
    };
  }
  if (current.mode === 'help' || current.mode === 'detail') {
    if (
      input === '?' ||
      input === '\r' ||
      input === '\n' ||
      input === '\u007f'
    ) {
      return {
        handled: true,
        state: closedControlPlane(current.returnFocus ?? 'input'),
      };
    }
    if (input === '/') {
      return {
        handled: true,
        state: openedControlPlane(
          'commands',
          '/',
          current.returnFocus ?? 'input',
        ),
      };
    }
    return { handled: true, state: current };
  }
  if (input === '\u001b[A') {
    return {
      handled: true,
      state: {
        ...current,
        selected: boundedIndex(current.selected, -1, itemCount),
      },
    };
  }
  if (input === '\u001b[B' || input === '\t') {
    return {
      handled: true,
      state: {
        ...current,
        selected: boundedIndex(current.selected, 1, itemCount),
      },
    };
  }
  if (input === '\r' || input === '\n') {
    return { handled: true, state: current, activate: itemCount > 0 };
  }
  if (input === '\u007f' || input === '\b') {
    const next = [...current.query].slice(0, -1).join('');
    if (current.mode === 'commands' && next === '') {
      return {
        handled: true,
        state: closedControlPlane(current.returnFocus ?? 'input'),
      };
    }
    return {
      handled: true,
      state: { ...current, query: next, selected: 0 },
    };
  }
  if (/^[\x20-\x7e]+$/.test(input)) {
    return {
      handled: true,
      state: {
        ...current,
        query: `${current.query}${input}`,
        selected: 0,
      },
    };
  }
  return { handled: true, state: current };
}
