// Rewind-domain capability handles: open the runtime home's recorded traced
// runs, list them, and load one run as decoded events plus its causal tree.
// Additive module beside the ADR-0011 five handles — same factory style, no
// import-time side effects.
//
// Events are decoded by reflection over each run's manifest-bound `.bfbs` —
// the same "decodable by reflection alone, no generated code" contract that
// C++ and Python honour (see kungfu.rewind README / replay.py). The shared
// ReflectionDecoder walks the schema; raw payload bytes come from the native
// journal frame via dataBytes(), and the schema bytes + msg_type→table binding
// come from the run's bundle (manifest.json + schemas/<hash>.bfbs), read
// through injected fs primitives. Adding a new event type (e.g. CostSnapshot)
// needs no change here: bind it in the schema, and reflection decodes it.
import {
  CallStatus,
  type CaptureLayer,
  type RunStatus,
} from './generated/rewind/fb.js';
import { ReflectionDecoder } from './schema.js';
import {
  type KfLocator,
  type KfNativeBinding,
  resolveRuntimeDir,
} from './types.js';

// the event-status vocabulary is part of this handle's surface (value enums,
// not table decoders — consumers compare status === CallStatus.Error etc.)
export { CallStatus, CaptureLayer, RunStatus } from './generated/rewind/fb.js';

// Known first-party event kinds (manifest binding.name). kfx events carry a
// fully-qualified table name, so the type stays open.
export type RewindEventKind =
  | 'RunBegin'
  | 'RunEnd'
  | 'ModelRequest'
  | 'ModelResponse'
  | 'ToolCall'
  | 'ToolResult'
  | 'RetryMarker'
  | 'CostSnapshot'
  | 'ApprovalDecision'
  | (string & {});

export type RewindEvent = {
  kind: RewindEventKind;
  genTime: bigint;
  runId: string;
  spanId?: string;
  parentSpanId?: string;
  layer?: CaptureLayer;
  status?: CallStatus;
  // model facts
  provider?: string;
  model?: string;
  requestBody?: string;
  responseBody?: string;
  finishReason?: string;
  inputTokens?: bigint;
  outputTokens?: bigint;
  // tool facts
  toolName?: string;
  input?: string;
  output?: string;
  error?: string;
  latencyNs?: bigint;
  // retry facts
  retryOfSpanId?: string;
  attempt?: number;
  // run facts
  command?: string;
  runtime?: string;
  exitCode?: number;
  runStatus?: RunStatus;
  // cost facts (CostSnapshot). attribution is the confidence level
  // (0 ExactRun .. 4 ManualEstimate); ambiguousAttribution flags shared-account
  // / shared-window usage that the source could not isolate.
  costUsd?: number;
  costUsdKnown?: boolean;
  attribution?: number;
  ambiguousAttribution?: boolean;
  workId?: string;
  sessionId?: string;
  surface?: string;
  // any decoded field not mapped to a typed slot above (kfx events, or new
  // schema fields added before this mapping table learns them).
  extra?: Record<string, unknown>;
};

export type RewindSpan = {
  spanId: string;
  open: RewindEvent;
  close?: RewindEvent;
  // a retry is an annotation on the attempt's span (same span_id), not a node
  retry?: RewindEvent;
  children: RewindSpan[];
};

export type RewindRunSummary = {
  runId: string;
  command?: string;
  beginTime: bigint;
  endTime?: bigint;
  runStatus?: RunStatus;
  exitCode?: number;
  eventCount: number;
  errorCount: number;
  // run-level cost rollup (summed across the run's CostSnapshot events)
  costUsd?: number;
  costUsdKnown?: boolean;
  inputTokens?: bigint;
  outputTokens?: bigint;
  ambiguousAttribution?: boolean;
  attribution?: number;
};

export type RewindRun = {
  summary: RewindRunSummary;
  events: RewindEvent[];
  roots: RewindSpan[];
};

export type Rewind = {
  runtimeDir: string;
  runs: () => RewindRunSummary[];
  loadRun: (runId: string) => RewindRun | null;
  refresh: () => void;
};

export type OpenRewindOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
  // Injected fs primitives — the SDK never touches the filesystem itself (same
  // environment-agnostic contract as the native binding). Rewind needs them to
  // read each run's bundle manifest + `.bfbs` schema blobs for reflection.
  readFile: (path: string) => Uint8Array;
  readDir: (dir: string) => string[];
};

const decoder = new TextDecoder();

// snake_case (reflection field name) -> camelCase (RewindEvent slot). The
// decode is otherwise field-name agnostic; only the causal/cost slots we type
// explicitly need mapping, everything else lands in `extra`.
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

// The typed slots on RewindEvent (camelCase). Anything else goes to `extra`.
const TYPED_SLOTS = new Set<string>([
  'runId',
  'spanId',
  'parentSpanId',
  'layer',
  'status',
  'provider',
  'model',
  'requestBody',
  'responseBody',
  'finishReason',
  'inputTokens',
  'outputTokens',
  'toolName',
  'input',
  'output',
  'error',
  'latencyNs',
  'retryOfSpanId',
  'attempt',
  'command',
  'runtime',
  'exitCode',
  'costUsd',
  'costUsdKnown',
  'attribution',
  'ambiguousAttribution',
  'workId',
  'sessionId',
  'surface',
]);

// Map a reflection-decoded record (snake_case fields, null for absent scalars)
// into the typed RewindEvent. `kind` comes from the manifest binding, not a
// per-type switch.
function toEvent(
  kind: string,
  genTime: bigint,
  raw: Record<string, unknown>,
): RewindEvent {
  const e: Record<string, unknown> = { kind, genTime, runId: '' };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    const camel = snakeToCamel(key);
    // RunEnd's `status` is a RunStatus; every other event's `status` is a
    // CallStatus. Route the run-terminal status to its own slot.
    if (kind === 'RunEnd' && camel === 'status') {
      e.runStatus = Number(value);
      continue;
    }
    if (TYPED_SLOTS.has(camel)) e[camel] = value;
    else extra[camel] = value;
  }
  if (Object.keys(extra).length > 0) e.extra = extra;
  return e as unknown as RewindEvent;
}

// The causal tree: spans open on ModelRequest/ToolCall/RetryMarker, close on
// their span-matched response/result; children hang off parentSpanId. Non-span
// events (RunBegin/RunEnd/CostSnapshot) carry no spanId and are skipped here.
function buildTree(events: RewindEvent[]): RewindSpan[] {
  const spans = new Map<string, RewindSpan>();
  const order: string[] = [];
  const pendingRetry = new Map<string, RewindEvent>();
  for (const event of events) {
    if (!event.spanId) continue;
    if (event.kind === 'RetryMarker') {
      // arrives just before the attempt's ToolCall with the same span_id
      pendingRetry.set(event.spanId, event);
    } else if (event.kind === 'ModelRequest' || event.kind === 'ToolCall') {
      spans.set(event.spanId, {
        spanId: event.spanId,
        open: event,
        retry: pendingRetry.get(event.spanId),
        children: [],
      });
      pendingRetry.delete(event.spanId);
      order.push(event.spanId);
    } else {
      const span = spans.get(event.spanId);
      if (span) span.close = event;
    }
  }
  const roots: RewindSpan[] = [];
  for (const spanId of order) {
    const span = spans.get(spanId);
    if (!span) continue;
    const parent = span.open.parentSpanId
      ? spans.get(span.open.parentSpanId)
      : undefined;
    if (parent) parent.children.push(span);
    else roots.push(span);
  }
  return roots;
}

// Roll a run's CostSnapshot events into one honest cost summary: report a total
// USD only when every snapshot's usd is known (else leave it undefined and fall
// back to tokens); flag ambiguous if any snapshot is ambiguous; keep the weakest
// attribution as the run's confidence floor (0 ExactRun strongest .. 4 weakest).
function summarizeCost(costs: RewindEvent[]): Partial<RewindRunSummary> {
  if (costs.length === 0) return {};
  let inputTokens = 0n;
  let outputTokens = 0n;
  let usd = 0;
  let allKnown = true;
  let ambiguousAttribution = false;
  let weakest = 0;
  for (const c of costs) {
    inputTokens += c.inputTokens ?? 0n;
    outputTokens += c.outputTokens ?? 0n;
    if (c.costUsdKnown) usd += c.costUsd ?? 0;
    else allKnown = false;
    if (c.ambiguousAttribution) ambiguousAttribution = true;
    if (c.attribution !== undefined && c.attribution > weakest) {
      weakest = c.attribution;
    }
  }
  return {
    costUsd: allKnown ? usd : undefined,
    costUsdKnown: allKnown,
    inputTokens,
    outputTokens,
    ambiguousAttribution,
    attribution: weakest,
  };
}

export function openRewind(options: OpenRewindOptions): Rewind {
  const { binding, readFile, readDir } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);

  let cache: Map<string, RewindEvent[]> | null = null;

  // Build msgType -> {kind, decoder} from every run's bundle manifest.
  // First-party schemas are content-addressed, so all runs bind the same
  // `.bfbs`; decoders are deduped by schema hash. (A per-run kfx schema reusing
  // one msgType with different bytes across runs would collide here — the
  // first-party rewind events this surface renders do not.)
  const loadBinders = (): Map<
    number,
    { kind: string; decoder: ReflectionDecoder }
  > => {
    const binders = new Map<
      number,
      { kind: string; decoder: ReflectionDecoder }
    >();
    const byHash = new Map<string, ReflectionDecoder>();
    let runIds: string[];
    try {
      runIds = readDir(`${runtimeDir}/rewind`);
    } catch {
      return binders; // no rewind runs recorded yet
    }
    for (const runId of runIds) {
      const bundle = `${runtimeDir}/rewind/${runId}/bundle`;
      let manifest: {
        schema_bindings?: Record<string, { name: string; schema_hash: string }>;
      };
      try {
        manifest = JSON.parse(
          decoder.decode(readFile(`${bundle}/manifest.json`)),
        );
      } catch {
        continue; // no bundle yet (e.g. a live run not exported), skip
      }
      for (const [mt, binding_] of Object.entries(
        manifest.schema_bindings ?? {},
      )) {
        const msgType = Number(mt);
        if (binders.has(msgType)) continue;
        let dec = byHash.get(binding_.schema_hash);
        if (!dec) {
          try {
            dec = new ReflectionDecoder(
              readFile(`${bundle}/schemas/${binding_.schema_hash}.bfbs`),
            );
          } catch {
            continue; // schema blob missing/unreadable, skip this binding
          }
          byHash.set(binding_.schema_hash, dec);
        }
        binders.set(msgType, { kind: binding_.name, decoder: dec });
      }
    }
    return binders;
  };

  const scan = (): Map<string, RewindEvent[]> => {
    const binders = loadBinders();
    const byRun = new Map<string, RewindEvent[]>();
    const assemble = new binding.Assemble([runtimeDir]);
    while (assemble.dataAvailable()) {
      const frame = assemble.currentFrame();
      const bound = binders.get(frame.msgType());
      if (bound) {
        const raw = bound.decoder.decode(frame.dataBytes(), bound.kind);
        const event = toEvent(bound.kind, frame.genTime(), raw);
        const bucket = byRun.get(event.runId);
        if (bucket) bucket.push(event);
        else byRun.set(event.runId, [event]);
      }
      assemble.next();
    }
    for (const events of byRun.values()) {
      events.sort((a, b) =>
        a.genTime < b.genTime ? -1 : a.genTime > b.genTime ? 1 : 0,
      );
    }
    return byRun;
  };

  const ensure = () => {
    if (!cache) cache = scan();
    return cache;
  };

  const summarize = (
    runId: string,
    events: RewindEvent[],
  ): RewindRunSummary => {
    const begin = events.find((e) => e.kind === 'RunBegin');
    const end = events.find((e) => e.kind === 'RunEnd');
    const cost = summarizeCost(events.filter((e) => e.kind === 'CostSnapshot'));
    return {
      runId,
      command: begin?.command,
      beginTime: events[0]?.genTime ?? 0n,
      endTime: end?.genTime,
      runStatus: end?.runStatus,
      exitCode: end?.exitCode,
      eventCount: events.length,
      errorCount: events.filter((e) => e.status === CallStatus.Error).length,
      ...cost,
    };
  };

  return {
    runtimeDir,
    refresh: () => {
      cache = null;
    },
    runs: () => {
      const byRun = ensure();
      return [...byRun.entries()]
        .map(([runId, events]) => summarize(runId, events))
        .sort((a, b) => (a.beginTime < b.beginTime ? 1 : -1));
    },
    loadRun: (runId: string) => {
      const events = ensure().get(runId);
      if (!events) return null;
      return {
        summary: summarize(runId, events),
        events,
        roots: buildTree(events),
      };
    },
  };
}
