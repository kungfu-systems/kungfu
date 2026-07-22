import type {
  WorkLoopInspection,
  WorkLoopRecoveryPlan,
} from '@kungfu-tech/api/capability';

export type WorkLoopSummary = {
  status: string;
  confidence: string;
  cutStatus: string;
  cutRoot: string;
  workId: string;
  workStatus: string;
  gaps: string[];
  nextActions: string[];
  recoveryAction: string;
  recoveryCode: string;
};

function stringField(
  value: Record<string, unknown> | null,
  key: string,
): string {
  const field = value?.[key];
  return typeof field === 'string' ? field : '';
}

export function summarizeWorkLoop(
  inspection: WorkLoopInspection,
  recovery: WorkLoopRecoveryPlan,
): WorkLoopSummary {
  return {
    status: inspection.status,
    confidence: inspection.confidence,
    cutStatus: inspection.cutStatus,
    cutRoot: stringField(inspection.cut, 'cutRoot'),
    workId: stringField(inspection.work, 'work_id'),
    workStatus: stringField(inspection.work, 'status'),
    gaps: [...inspection.gaps],
    nextActions: [...inspection.nextActions],
    recoveryAction: recovery.action,
    recoveryCode: recovery.code,
  };
}
