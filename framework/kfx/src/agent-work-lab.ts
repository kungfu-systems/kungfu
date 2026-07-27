// SPDX-License-Identifier: Apache-2.0

export type AgentWorkLabCaseId = 'offline-demo' | 'same-agent' | 'cross-agent';

export type AgentWorkLabCheckMeaning = {
  title: string;
  meaning: string;
};

export type AgentWorkLabCase = {
  id: AgentWorkLabCaseId;
  title: string;
  shortTitle: string;
  description: string;
  sourceRequirement: 'bundled' | 'configured';
  targetRequirement: 'fresh-demo' | 'same' | 'different';
  runLabel: string;
};

export type AgentWorkLabRecommendation = {
  title: string;
  instruction: string;
  nextCase?: AgentWorkLabCaseId;
};

export const AGENT_WORK_LAB_SUITE = {
  id: 'kungfu.agent-work-lab',
  title: 'Agent Work Lab',
  collection: {
    id: 'work-continuity',
    title: 'Work Continuity',
    description:
      'See whether fresh agent sessions can continue the same governed Work without copied chat.',
  },
  cases: [
    {
      id: 'offline-demo',
      title: 'Offline demo',
      shortTitle: 'Demo',
      description:
        'Watch two bundled fresh processes demonstrate a bounded stop and governed continuation.',
      sourceRequirement: 'bundled',
      targetRequirement: 'fresh-demo',
      runLabel: 'running two fresh demo sessions',
    },
    {
      id: 'same-agent',
      title: 'Same agent',
      shortTitle: 'Same',
      description:
        'Run the selected agent twice and verify that a fresh process recovers the same Work.',
      sourceRequirement: 'configured',
      targetRequirement: 'same',
      runLabel: 'running selected agent twice',
    },
    {
      id: 'cross-agent',
      title: 'Agent handoff',
      shortTitle: 'Handoff',
      description:
        'Start with one agent and ask a different agent to continue from governed evidence.',
      sourceRequirement: 'configured',
      targetRequirement: 'different',
      runLabel: 'running cross-provider handoff',
    },
  ] satisfies AgentWorkLabCase[],
  timing: {
    eventIntervalMs: 1000,
    verdictIntervalMs: 520,
    recommendationDurationMs: 5000,
    quietProgressIntervalMs: 1000,
    reducedMotionIntervalMs: 24,
  },
} as const;

export const AGENT_WORK_LAB_KFX_SUITE = {
  title: AGENT_WORK_LAB_SUITE.title,
  members: [
    'agent-work-lab-catalog',
    'agent-work-lab-gui',
    'agent-work-lab-tui',
  ],
} as const;

export const AGENT_WORK_LAB_CHECKS: Record<string, AgentWorkLabCheckMeaning> = {
  'two-distinct-fresh-processes': {
    title: 'Two genuinely fresh processes',
    meaning:
      'Kungfu observed two different process identities instead of reusing one hidden session.',
  },
  'distinct-fresh-processes': {
    title: 'Two genuinely fresh processes',
    meaning: 'Session 2 did not reuse the Session 1 provider process.',
  },
  'first-attempt-ended-partial': {
    title: 'Session 1 stopped at a bounded partial result',
    meaning:
      'The first process left durable evidence instead of pretending to finish.',
  },
  'second-attempt-no-transcript-or-explanation': {
    title: 'Session 2 received no copied chat',
    meaning:
      'Continuation came from governed Work, not hidden transcript transfer.',
  },
  'second-attempt-recognized-partial-state': {
    title: 'Session 2 recovered the partial state',
    meaning: 'The fresh process found what was done and what remained.',
  },
  'fixture-completed': {
    title: 'The original Work was completed',
    meaning:
      'The second process continued the same identity to its expected result.',
  },
  'both-processes-exited-cleanly': {
    title: 'Both agent processes exited cleanly',
    meaning:
      'Process completion was observed for both sessions without treating exit alone as task proof.',
  },
  'fresh-session-completed-exact-state': {
    title: 'The fresh session completed the exact governed task',
    meaning:
      'The final state retained the same Work identity and the expected ordered steps.',
  },
};

export const AGENT_WORK_LAB_RECOMMENDATIONS: Record<
  AgentWorkLabCaseId,
  AgentWorkLabRecommendation
> = {
  'offline-demo': {
    title: 'Offline complete · now test your real agent',
    instruction:
      'Run Same agent to verify continuity with your selected provider.',
    nextCase: 'same-agent',
  },
  'same-agent': {
    title: 'Same-agent complete · now test a handoff',
    instruction: 'Choose a different target, then run Agent handoff.',
    nextCase: 'cross-agent',
  },
  'cross-agent': {
    title: 'Handoff complete · inspect the evidence',
    instruction:
      'Open Correct or Failed to see every continuity check and its meaning.',
  },
};

export function agentWorkLabCase(id: AgentWorkLabCaseId): AgentWorkLabCase {
  const found = AGENT_WORK_LAB_SUITE.cases.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown Agent Work Lab case: ${id}`);
  return found;
}

export function agentWorkLabRecommendation(
  id: AgentWorkLabCaseId,
): AgentWorkLabRecommendation {
  return AGENT_WORK_LAB_RECOMMENDATIONS[id];
}
