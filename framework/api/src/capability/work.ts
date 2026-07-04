// Work-domain capability handle: open the runtime home's work items — the
// default work profile — as the same folded projection the `kungfu work` CLI
// renders. Additive module beside the ADR-0011 five handles — same factory
// style, no import-time side effects. Decoding uses the flatc-generated
// accessors for the work event schema (open-layer msg types 30101-30199);
// the raw payload bytes come from the native frame via dataBytes().
import * as flatbuffers from 'flatbuffers';
import {
  ArtifactRecorded,
  CheckpointRecorded,
  DecisionRecorded,
  NextActionSet,
  RunLinked,
  ValidationRecorded,
  ValidationResult,
  WorkItemCreated,
  WorkStatus,
  WorkStatusChanged,
} from './generated/work/fb.js';
import {
  type KfLocator,
  type KfNativeBinding,
  resolveRuntimeDir,
} from './types.js';

// the lifecycle vocabulary is part of this handle's surface
export { ValidationResult, WorkStatus } from './generated/work/fb.js';

export const WORK_MSG = {
  WorkItemCreated: 30101,
  WorkStatusChanged: 30102,
  NextActionSet: 30103,
  CheckpointRecorded: 30104,
  DecisionRecorded: 30105,
  ValidationRecorded: 30106,
  ArtifactRecorded: 30107,
  RunLinked: 30108,
} as const;

const WORK_MSG_MIN = 30101;
const WORK_MSG_MAX = 30108;

export const WORK_STATUS_NAMES: Record<WorkStatus, string> = {
  [WorkStatus.Active]: 'active',
  [WorkStatus.Waiting]: 'waiting',
  [WorkStatus.Blocked]: 'blocked',
  [WorkStatus.Ready]: 'ready',
  [WorkStatus.Done]: 'done',
};

export type WorkHistoryEntry = {
  time: bigint;
  event: 'created' | 'status';
  status?: WorkStatus;
  reason?: string;
};

export type WorkItem = {
  workId: string;
  title?: string;
  kind?: string;
  summary?: string;
  status?: WorkStatus;
  nextAction?: string;
  createdTime?: bigint;
  updatedTime: bigint;
  checkpoints: { time: bigint; note?: string }[];
  decisions: { time: bigint; decision?: string; decidedBy?: string }[];
  validations: {
    time: bigint;
    result: ValidationResult;
    command?: string;
    note?: string;
  }[];
  artifacts: { time: bigint; ref?: string; kind?: string }[];
  runs: { time: bigint; runId?: string }[];
  history: WorkHistoryEntry[];
};

export type Work = {
  runtimeDir: string;
  items: () => WorkItem[];
  item: (workId: string) => WorkItem | null;
  refresh: () => void;
};

export type OpenWorkOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
};

const str = (value: string | null | undefined) => value ?? undefined;

export function openWork(options: OpenWorkOptions): Work {
  const { binding } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);

  let cache: Map<string, WorkItem> | null = null;

  const shell = (workId: string, time: bigint): WorkItem => ({
    workId,
    updatedTime: time,
    checkpoints: [],
    decisions: [],
    validations: [],
    artifacts: [],
    runs: [],
    history: [],
  });

  // Fold the event stream into current items — the same projection the
  // python store computes; state never lives anywhere but the fold.
  const scan = (): Map<string, WorkItem> => {
    const frames: { genTime: bigint; msgType: number; bytes: Uint8Array }[] =
      [];
    const assemble = new binding.Assemble([runtimeDir]);
    while (assemble.dataAvailable()) {
      const frame = assemble.currentFrame();
      const msgType = frame.msgType();
      if (msgType >= WORK_MSG_MIN && msgType <= WORK_MSG_MAX) {
        frames.push({
          genTime: frame.genTime(),
          msgType,
          bytes: frame.dataBytes(),
        });
      }
      assemble.next();
    }
    frames.sort((a, b) =>
      a.genTime < b.genTime ? -1 : a.genTime > b.genTime ? 1 : 0,
    );

    const items = new Map<string, WorkItem>();
    const entry = (workId: string, time: bigint): WorkItem => {
      let item = items.get(workId);
      if (!item) {
        item = shell(workId, time);
        items.set(workId, item);
      }
      item.updatedTime = time;
      return item;
    };

    for (const { genTime, msgType, bytes } of frames) {
      const bb = new flatbuffers.ByteBuffer(bytes);
      switch (msgType) {
        case WORK_MSG.WorkItemCreated: {
          const e = WorkItemCreated.getRootAsWorkItemCreated(bb);
          const item = entry(e.workId() ?? '', genTime);
          item.title = str(e.title());
          item.kind = str(e.kind());
          item.summary = str(e.summary());
          item.status = WorkStatus.Active;
          item.createdTime = genTime;
          item.history.push({ time: genTime, event: 'created' });
          break;
        }
        case WORK_MSG.WorkStatusChanged: {
          const e = WorkStatusChanged.getRootAsWorkStatusChanged(bb);
          const item = entry(e.workId() ?? '', genTime);
          item.status = e.status();
          item.history.push({
            time: genTime,
            event: 'status',
            status: e.status(),
            reason: str(e.reason()),
          });
          break;
        }
        case WORK_MSG.NextActionSet: {
          const e = NextActionSet.getRootAsNextActionSet(bb);
          entry(e.workId() ?? '', genTime).nextAction = str(e.nextAction());
          break;
        }
        case WORK_MSG.CheckpointRecorded: {
          const e = CheckpointRecorded.getRootAsCheckpointRecorded(bb);
          entry(e.workId() ?? '', genTime).checkpoints.push({
            time: genTime,
            note: str(e.note()),
          });
          break;
        }
        case WORK_MSG.DecisionRecorded: {
          const e = DecisionRecorded.getRootAsDecisionRecorded(bb);
          entry(e.workId() ?? '', genTime).decisions.push({
            time: genTime,
            decision: str(e.decision()),
            decidedBy: str(e.decidedBy()),
          });
          break;
        }
        case WORK_MSG.ValidationRecorded: {
          const e = ValidationRecorded.getRootAsValidationRecorded(bb);
          entry(e.workId() ?? '', genTime).validations.push({
            time: genTime,
            result: e.result(),
            command: str(e.command()),
            note: str(e.note()),
          });
          break;
        }
        case WORK_MSG.ArtifactRecorded: {
          const e = ArtifactRecorded.getRootAsArtifactRecorded(bb);
          entry(e.workId() ?? '', genTime).artifacts.push({
            time: genTime,
            ref: str(e.ref()),
            kind: str(e.kind()),
          });
          break;
        }
        case WORK_MSG.RunLinked: {
          const e = RunLinked.getRootAsRunLinked(bb);
          entry(e.workId() ?? '', genTime).runs.push({
            time: genTime,
            runId: str(e.runId()),
          });
          break;
        }
      }
    }
    return items;
  };

  const ensure = () => {
    if (!cache) cache = scan();
    return cache;
  };

  return {
    runtimeDir,
    refresh: () => {
      cache = null;
    },
    items: () =>
      [...ensure().values()].sort((a, b) =>
        a.updatedTime < b.updatedTime
          ? 1
          : a.updatedTime > b.updatedTime
            ? -1
            : 0,
      ),
    item: (workId: string) => ensure().get(workId) ?? null,
  };
}
