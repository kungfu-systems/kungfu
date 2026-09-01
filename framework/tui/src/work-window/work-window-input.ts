// SPDX-License-Identifier: Apache-2.0

import type { ProjectWorkCapturePlan } from '@kungfu-tech/api/capability';

export type ProjectWorkComposer = {
  step: 'objective' | 'acceptance' | 'preview' | 'capturing';
  objective: string;
  acceptanceCriterion: string;
  plan?: ProjectWorkCapturePlan;
};

export type WorkWindowInputContext = {
  agentReply?: string;
  composer?: ProjectWorkComposer;
  planPending: boolean;
  retainedAgentReviewable: boolean;
  attentionKind?: 'blocked' | 'needs-approval' | 'needs-answer' | string;
  sessionControllable?: boolean;
};

export type WorkWindowInputAction =
  | { kind: 'none' }
  | { kind: 'set-agent-reply'; value?: string }
  | { kind: 'submit-agent-reply' }
  | { kind: 'set-composer'; value?: ProjectWorkComposer; message?: string }
  | { kind: 'capture-composed-work' }
  | { kind: 'preview-composed-work' }
  | { kind: 'cancel-plan' }
  | { kind: 'confirm-plan' }
  | { kind: 'exit' }
  | { kind: 'open-lab' }
  | { kind: 'focus-file-tree' }
  | { kind: 'open-projects' }
  | { kind: 'continue-retained-work' }
  | { kind: 'retry-agent-attempt' }
  | { kind: 'begin-new-work' }
  | { kind: 'decide-agent-approval'; approved: boolean }
  | { kind: 'preview-agent-run' };

const NO_WORK_WINDOW_INPUT_ACTION = { kind: 'none' } as const;

function printableTerminalInput(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

function agentReplyInputAction(
  value: string,
  reply: string,
): WorkWindowInputAction {
  if (value === '\u001b') return { kind: 'set-agent-reply' };
  if (value === '\u007f' || value === '\b')
    return { kind: 'set-agent-reply', value: reply.slice(0, -1) };
  if (value === '\r' || value === '\n') return { kind: 'submit-agent-reply' };
  if (printableTerminalInput(value))
    return {
      kind: 'set-agent-reply',
      value: `${reply}${value}`.slice(0, 1000),
    };
  return NO_WORK_WINDOW_INPUT_ACTION;
}

function composerInputAction(
  value: string,
  composer: ProjectWorkComposer,
): WorkWindowInputAction {
  if (composer.step === 'capturing') return NO_WORK_WINDOW_INPUT_ACTION;
  if (composer.step === 'preview') {
    if (value === '\u001b' || value === 'b')
      return {
        kind: 'set-composer',
        value: { ...composer, step: 'acceptance', plan: undefined },
      };
    if (value === '\r' || value === '\n')
      return { kind: 'capture-composed-work' };
    return NO_WORK_WINDOW_INPUT_ACTION;
  }
  if (value === '\u001b')
    return {
      kind: 'set-composer',
      message: 'New Work cancelled; nothing was captured.',
    };
  if (value === '\u007f' || value === '\b')
    return {
      kind: 'set-composer',
      value:
        composer.step === 'objective'
          ? { ...composer, objective: composer.objective.slice(0, -1) }
          : {
              ...composer,
              acceptanceCriterion: composer.acceptanceCriterion.slice(0, -1),
            },
    };
  if (value === '\r' || value === '\n') {
    if (composer.step === 'objective') {
      if (!composer.objective.trim()) return NO_WORK_WINDOW_INPUT_ACTION;
      return {
        kind: 'set-composer',
        value: { ...composer, step: 'acceptance' },
        message: 'Define the result that independent review should check.',
      };
    }
    if (!composer.acceptanceCriterion.trim())
      return NO_WORK_WINDOW_INPUT_ACTION;
    return { kind: 'preview-composed-work' };
  }
  if (!printableTerminalInput(value)) return NO_WORK_WINDOW_INPUT_ACTION;
  return {
    kind: 'set-composer',
    value:
      composer.step === 'objective'
        ? {
            ...composer,
            objective: `${composer.objective}${value}`.slice(0, 320),
          }
        : {
            ...composer,
            acceptanceCriterion:
              `${composer.acceptanceCriterion}${value}`.slice(0, 320),
          },
  };
}

function defaultWorkWindowInputAction(
  value: string,
  context: WorkWindowInputContext,
): WorkWindowInputAction {
  if (value === 'q' || value === '\u0003') return { kind: 'exit' };
  if (value === 'a') return { kind: 'open-lab' };
  if (value === 't') return { kind: 'focus-file-tree' };
  if (value === 'p' || value === '\u001b') return { kind: 'open-projects' };
  if ((value === 'v' || value === '\r') && context.retainedAgentReviewable)
    return { kind: 'continue-retained-work' };
  if (context.attentionKind === 'blocked' && value === 'r')
    return { kind: 'retry-agent-attempt' };
  if (context.sessionControllable === false) return NO_WORK_WINDOW_INPUT_ACTION;
  if (value === 'n' || value === '\r') return { kind: 'begin-new-work' };
  if (context.attentionKind === 'needs-approval' && value === 'y')
    return { kind: 'decide-agent-approval', approved: true };
  if (context.attentionKind === 'needs-approval' && value === 'n')
    return { kind: 'decide-agent-approval', approved: false };
  if (context.attentionKind === 'needs-answer' && value === 'i')
    return { kind: 'set-agent-reply', value: '' };
  if (value === 'r') return { kind: 'preview-agent-run' };
  return NO_WORK_WINDOW_INPUT_ACTION;
}

export function workWindowInputAction(
  value: string,
  context: WorkWindowInputContext,
): WorkWindowInputAction {
  if (context.agentReply !== undefined)
    return agentReplyInputAction(value, context.agentReply);
  if (context.composer) return composerInputAction(value, context.composer);
  if (context.planPending) {
    if (value === '\u001b' || value === 'b' || value === 'n')
      return { kind: 'cancel-plan' };
    if (value === '\r' || value === 'y') return { kind: 'confirm-plan' };
    return NO_WORK_WINDOW_INPUT_ACTION;
  }
  return defaultWorkWindowInputAction(value, context);
}
