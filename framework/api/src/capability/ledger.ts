// Ledger-domain capability handles (KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1): open a ledger, iterate
// ordered records, subscribe to live updates, obtain replay anchors, and
// query live-bus health. Factory-style, no import-time side effects.
import {
  type KfLocator,
  type KfNativeBinding,
  type LedgerRecord,
  type LiveHealth,
  type RecordFilter,
  type ReplayAnchor,
  type Subscription,
  resolveRuntimeDir,
} from './types.js';

export type OpenLedgerOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
  // Join the live bus under this participant name. Joining also initializes
  // a fresh runtime home's layout. Without join, the ledger is read-only and
  // health reports joined=false.
  join?: { name: string };
};

export type Ledger = {
  runtimeDir: string;
  records: (filter?: RecordFilter) => LedgerRecord[];
  subscribe: (
    onRecords: (records: LedgerRecord[]) => void,
    options?: { intervalMs?: number; filter?: RecordFilter },
  ) => Subscription;
  replayAnchors: () => ReplayAnchor[];
  health: () => LiveHealth;
  formatNanos: (nanos: bigint, format?: string) => string;
};

const SCAN_HARD_LIMIT = 1_000_000;

export function openLedger(options: OpenLedgerOptions): Ledger {
  const { binding } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);

  let watcher: InstanceType<KfNativeBinding['Watcher']> | null = null;
  let joined = false;
  if (options.join) {
    // Constructing a watcher initializes the runtime home layout; starting
    // it makes it join a live coordinator when one is running.
    watcher = new binding.Watcher(runtimeDir, options.join.name, true, 50);
    if (!watcher.isStarted()) watcher.start();
    joined = true;
  }

  const records = (filter?: RecordFilter): LedgerRecord[] => {
    const assemble = new binding.Assemble([runtimeDir]);
    const limit = filter?.limit ?? SCAN_HARD_LIMIT;
    const result: LedgerRecord[] = [];
    while (assemble.dataAvailable() && result.length < limit) {
      const frame = assemble.currentFrame();
      const genTime = frame.genTime();
      const carrierType = frame.carrierType();
      const wanted =
        (filter?.carrierType === undefined ||
          carrierType === filter.carrierType) &&
        (filter?.sinceNanos === undefined || genTime > filter.sinceNanos);
      if (wanted) {
        result.push({
          genTime,
          triggerTime: frame.triggerTime(),
          frameUid: frame.frameUid(),
          triggerFrameUid: frame.triggerFrameUid(),
          streamId: frame.streamId(),
          carrierType,
          source: frame.source(),
          initialSource: frame.initialSource(),
          dest: frame.dest(),
          dataLength: frame.dataLength(),
          dataType: frame.dataType(),
        });
      }
      assemble.next();
    }
    return result;
  };

  const subscribe: Ledger['subscribe'] = (onRecords, subscribeOptions) => {
    // Polling implementation behind a stable interface: rescan and emit
    // records newer than the last high-water mark.
    let highWater = 0n;
    const emit = () => {
      const fresh = records({
        ...subscribeOptions?.filter,
        sinceNanos: highWater,
      });
      if (fresh.length > 0) {
        highWater = fresh[fresh.length - 1].genTime;
        onRecords(fresh);
      }
    };
    emit();
    const timer = setInterval(emit, subscribeOptions?.intervalMs ?? 2000);
    return { stop: () => clearInterval(timer) };
  };

  const replayAnchors = (): ReplayAnchor[] => {
    const rows = binding.storageEpisodeListTyped(runtimeDir, {
      limit: SCAN_HARD_LIMIT,
    }).episodes;
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      const open = record.open as Record<string, unknown>;
      const close = record.close as Record<string, unknown>;
      const closed = Boolean(record.closed);
      return {
        episodeId: BigInt((record.episode_id as bigint | string) ?? 0),
        locationUid: Number(open.location_uid ?? 0),
        beginTime: BigInt((open.begin_time as bigint | string) ?? 0),
        endTime: BigInt(
          ((closed ? close.end_time : record.update_time) as bigint | string) ??
            0,
        ),
        frameCount: BigInt((record.unique_frame_count as bigint | string) ?? 0),
        lastFrameUid: BigInt((record.last_frame_uid as bigint | string) ?? 0),
        closed,
      };
    });
  };

  const health = (): LiveHealth => {
    if (!watcher) return { joined: false, live: false, usable: false };
    let live = false;
    let usable = false;
    try {
      live = watcher.isLive();
      usable = watcher.isUsable();
    } catch {
      // treat probe failures as not live; health must never throw
    }
    return { joined, live, usable };
  };

  const formatNanos = (nanos: bigint, format = '%H:%M:%S.%N'): string => {
    try {
      if (binding.formatTime) return binding.formatTime(nanos, format);
    } catch {
      // fall through to raw nanoseconds
    }
    return String(nanos);
  };

  return { runtimeDir, records, subscribe, replayAnchors, health, formatNanos };
}
