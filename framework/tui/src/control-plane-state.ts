// SPDX-License-Identifier: Apache-2.0

import type { ProductSearchDocument } from '@kungfu-tech/api/capability';
import { boundedIndex } from './navigation.js';

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
  | 'work'
  | 'projects'
  | 'lab'
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
