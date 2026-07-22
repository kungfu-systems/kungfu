// SPDX-License-Identifier: Apache-2.0

// The ordinary GUI describes one workspace runtime, not its implementation
// processes. Raw supervisor/coordinator facts remain available to the advanced
// Status view, while the tray and status bar consume this foreground model.

import type { RuntimeProductStatus } from '@kungfu-tech/api/capability';

export type WorkspaceRuntimeState =
  | 'checking'
  | 'available'
  | 'online'
  | 'ready'
  | 'starting'
  | 'reconnecting'
  | 'recovering'
  | 'degraded'
  | 'needs-attention'
  | 'offline';

export type WorkspaceRuntimeContinuityState =
  | 'ready'
  | 'reconnecting'
  | 'recovering'
  | 'degraded'
  | 'needs-attention';

export type RuntimeStatusPayload = {
  status?: string;
  configHome?: string;
  dataRoot?: string;
  runtimeDir?: string;
  lifecycle?: {
    state?: string;
    healthy?: boolean;
    warnings?: string[];
  };
  // Optional forward-compatible foreground contract. Until Core reports this,
  // process health proves only `online`, never peer/session continuity.
  continuity?: {
    state?: WorkspaceRuntimeContinuityState;
    reason?: string;
  };
  product?: RuntimeProductStatus;
  supervisor?: { pid?: number | null; running?: boolean };
  coordinator?: { pid?: number | null; running?: boolean };
  route?: {
    routeId?: string;
    registered?: boolean;
    stale?: boolean;
    freshness?: { ageSeconds?: number | null; ttlSeconds?: number };
  };
  routes?: { count?: number; staleCount?: number };
  assessments?: {
    assessment_count?: number;
    counts?: Record<string, number>;
    assessments?: Array<{
      state?: string;
      assessment_key?: string;
      request?: { claim_id?: string; purpose?: string };
      report?: { residual_risks?: string[]; query_proof_root?: string };
    }>;
  };
};

export type RuntimeStatusResult = {
  ok: boolean;
  payload: RuntimeStatusPayload | null;
  error: string;
  updatedAt: number;
};

export type WorkspaceRuntimePresentation = {
  state: WorkspaceRuntimeState;
  label: string;
  detail: string;
  icon: '●' | '○' | '◐' | '!';
  severity: 'info' | 'ok' | 'warning' | 'error';
};

const NEEDS_ATTENTION_LIFECYCLES = new Set([
  'dead',
  'orphan-coordinator',
  'stale-route',
]);

function presentation(
  state: WorkspaceRuntimeState,
  label: string,
  detail: string,
  icon: WorkspaceRuntimePresentation['icon'],
  severity: WorkspaceRuntimePresentation['severity'],
): WorkspaceRuntimePresentation {
  return { state, label, detail, icon, severity };
}

export function deriveWorkspaceRuntimePresentation(
  result: RuntimeStatusResult | null,
): WorkspaceRuntimePresentation {
  if (!result) {
    return presentation(
      'checking',
      'Workspace checking',
      'Workspace readiness is being checked.',
      '◐',
      'info',
    );
  }
  if (!result.ok || !result.payload) {
    return presentation(
      'needs-attention',
      'Workspace unavailable',
      result.error || 'Workspace status is unavailable.',
      '!',
      'error',
    );
  }

  const payload = result.payload;
  const product = payload.product;
  if (product) {
    if (product.error || product.liveState === 'failed') {
      return presentation(
        'needs-attention',
        'Live capabilities need attention',
        product.error?.message || 'Automatic live activation needs attention.',
        '!',
        'error',
      );
    }
    if (product.liveState === 'inactive' || product.liveState === 'stopped') {
      return presentation(
        'available',
        'Workspace available',
        'Durable work is available; live capabilities activate when required.',
        '●',
        'ok',
      );
    }
    if (product.liveState === 'ready') {
      return presentation(
        'ready',
        'Workspace ready',
        'Required live capabilities are ready at the reported durable cut.',
        '●',
        'ok',
      );
    }
    if (product.liveState === 'draining') {
      return presentation(
        'available',
        'Workspace available',
        'Durable work remains available while unused live capabilities stop.',
        '●',
        'ok',
      );
    }
    return presentation(
      product.liveState === 'starting' ? 'starting' : 'recovering',
      product.liveState === 'starting'
        ? 'Live capabilities starting'
        : 'Live capabilities recovering',
      'Automatic activation is establishing the required durable cut.',
      '◐',
      'warning',
    );
  }
  const lifecycle = payload.lifecycle?.state || payload.status || '';
  const warnings = payload.lifecycle?.warnings?.filter(Boolean) ?? [];
  const warningDetail = warnings.length ? ` ${warnings.join(', ')}.` : '';
  const supervisorRunning = payload.supervisor?.running === true;
  const coordinatorRunning = payload.coordinator?.running === true;

  // Process/lifecycle failure always wins over a continuity claim. A stale
  // foreground projection must never turn a dead authority green.
  if (NEEDS_ATTENTION_LIFECYCLES.has(lifecycle)) {
    return presentation(
      'needs-attention',
      'Workspace needs attention',
      `Automatic runtime recovery is not healthy.${warningDetail}`,
      '!',
      'error',
    );
  }
  if (coordinatorRunning && !supervisorRunning) {
    return presentation(
      'needs-attention',
      'Workspace needs attention',
      'The workspace runtime has lost its automatic recovery owner.',
      '!',
      'error',
    );
  }
  if (!supervisorRunning && !coordinatorRunning) {
    return presentation(
      'offline',
      'Workspace offline',
      'The workspace runtime is stopped.',
      '○',
      'warning',
    );
  }
  if (supervisorRunning && !coordinatorRunning) {
    return presentation(
      'starting',
      'Workspace starting',
      'The workspace runtime is starting or being restarted.',
      '◐',
      'warning',
    );
  }

  const continuity = payload.continuity;
  if (continuity?.state === 'needs-attention') {
    return presentation(
      'needs-attention',
      'Workspace needs attention',
      continuity.reason || 'Automatic workspace recovery needs attention.',
      '!',
      'error',
    );
  }
  if (continuity?.state === 'degraded' || lifecycle === 'degraded') {
    return presentation(
      'degraded',
      'Workspace degraded',
      continuity?.reason ||
        `The workspace is available with reduced capabilities.${warningDetail}`,
      '!',
      'warning',
    );
  }
  if (continuity?.state === 'reconnecting') {
    return presentation(
      'reconnecting',
      'Workspace reconnecting',
      continuity.reason ||
        'Running agents are reconnecting to the current workspace runtime.',
      '◐',
      'warning',
    );
  }
  if (continuity?.state === 'recovering') {
    return presentation(
      'recovering',
      'Workspace recovering',
      continuity.reason || 'Workspace state is recovering and catching up.',
      '◐',
      'warning',
    );
  }
  if (continuity?.state === 'ready' && payload.lifecycle?.healthy === true) {
    return presentation(
      'ready',
      'Workspace ready',
      continuity.reason ||
        'The workspace runtime and live sessions are current.',
      '●',
      'ok',
    );
  }

  if (payload.lifecycle?.healthy === false) {
    return presentation(
      'recovering',
      'Workspace recovering',
      `The workspace runtime is online but has not reported healthy.${warningDetail}`,
      '◐',
      'warning',
    );
  }

  return presentation(
    'online',
    'Workspace online',
    'The workspace runtime is online; live-session continuity is not yet reported.',
    '●',
    'info',
  );
}
