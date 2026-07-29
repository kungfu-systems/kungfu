// SPDX-License-Identifier: Apache-2.0

import suiteCatalog from '../catalog.json' with { type: 'json' };

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

export type AgentWorkLabSuite = {
  schema: 'kungfu.agent-work-lab.suite-catalog/v1';
  id: 'kungfu.agent-work-lab';
  version: string;
  title: string;
  collection: {
    id: 'work-continuity';
    title: string;
    description: string;
  };
  cases: AgentWorkLabCase[];
  checks: Record<string, AgentWorkLabCheckMeaning>;
  recommendations: Record<AgentWorkLabCaseId, AgentWorkLabRecommendation>;
  recoveryGuidance: Record<
    'agent-unavailable' | 'run-failed' | 'existing-work' | 'demo-retry',
    string
  >;
  timing: {
    autoplayIntroDurationMs: number;
    eventIntervalMs: number;
    verdictIntervalMs: number;
    recommendationDurationMs: number;
    quietProgressIntervalMs: number;
    reducedMotionIntervalMs: number;
  };
  capabilityDeclarations: string[];
  claims: string[];
  nonClaims: string[];
  oracle: string;
};

export const AGENT_WORK_LAB_SUITE =
  suiteCatalog as unknown as AgentWorkLabSuite;

export const AGENT_WORK_LAB_CHECKS = AGENT_WORK_LAB_SUITE.checks;

export const AGENT_WORK_LAB_RECOMMENDATIONS =
  AGENT_WORK_LAB_SUITE.recommendations;

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
