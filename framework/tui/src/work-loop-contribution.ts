// TUI projection of the shared WorkLoop capability. It stays a presentation
// model: inspection and recovery are both read-only public CLI receipts.
import type {
  WorkLoopInspection,
  WorkLoopRecoveryPlan,
} from '@kungfu-tech/api/capability';

export type WorkLoopShellModel = {
  status: string;
  confidence: string;
  cutStatus: string;
  cutRoot: string;
  workId: string;
  gaps: string[];
  nextActions: string[];
  recoveryAction: string;
  recoveryCode: string;
};

function field(value: Record<string, unknown> | null, key: string): string {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : '';
}

export function workLoopShellModel(
  inspection: WorkLoopInspection,
  recovery: WorkLoopRecoveryPlan,
): WorkLoopShellModel {
  return {
    status: inspection.status,
    confidence: inspection.confidence,
    cutStatus: inspection.cutStatus,
    cutRoot: field(inspection.cut, 'cutRoot'),
    workId: field(inspection.work, 'work_id'),
    gaps: [...inspection.gaps],
    nextActions: [...inspection.nextActions],
    recoveryAction: recovery.action,
    recoveryCode: recovery.code,
  };
}
