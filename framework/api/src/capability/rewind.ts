// Rewind-domain capability handles: open the runtime home's recorded traced
// runs, list them, and load one run as decoded events plus its causal tree.
// Additive module beside the ADR-0011 five handles — same factory style, no
// import-time side effects. Decoding uses the flatc-generated accessors for
// the rewind event schema (open-layer msg types 30001-30099); the raw payload
// bytes come from the native frame via dataBytes().
import * as flatbuffers from 'flatbuffers';
import {
  CallStatus,
  CaptureLayer,
  ModelRequest,
  ModelResponse,
  RetryMarker,
  RunBegin,
  RunEnd,
  RunStatus,
  ToolCall,
  ToolResult,
} from './generated/rewind/fb.js';
import {
  type KfLocator,
  type KfNativeBinding,
  resolveRuntimeDir,
} from './types';

// the event-status vocabulary is part of this handle's surface
export { CallStatus, CaptureLayer, RunStatus } from './generated/rewind/fb.js';

export const REWIND_MSG = {
  RunBegin: 30001,
  RunEnd: 30002,
  ModelRequest: 30003,
  ModelResponse: 30004,
  ToolCall: 30005,
  ToolResult: 30006,
  RetryMarker: 30007,
} as const;

const REWIND_MSG_MIN = 30001;
const REWIND_MSG_MAX = 30007;

export type RewindEventKind = keyof typeof REWIND_MSG;

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
};

export type RewindSpan = {
  spanId: string;
  open: RewindEvent;
  close?: RewindEvent;
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
};

const str = (value: string | null | undefined) => value ?? undefined;

function decode(msgType: number, bytes: Uint8Array): Omit<RewindEvent, 'genTime'> | null {
  const bb = new flatbuffers.ByteBuffer(bytes);
  switch (msgType) {
    case REWIND_MSG.RunBegin: {
      const e = RunBegin.getRootAsRunBegin(bb);
      return {
        kind: 'RunBegin',
        runId: e.runId() ?? '',
        command: str(e.command()),
        runtime: str(e.runtime()),
      };
    }
    case REWIND_MSG.RunEnd: {
      const e = RunEnd.getRootAsRunEnd(bb);
      return {
        kind: 'RunEnd',
        runId: e.runId() ?? '',
        runStatus: e.status(),
        exitCode: e.exitCode(),
      };
    }
    case REWIND_MSG.ModelRequest: {
      const e = ModelRequest.getRootAsModelRequest(bb);
      return {
        kind: 'ModelRequest',
        runId: e.runId() ?? '',
        spanId: str(e.spanId()),
        parentSpanId: str(e.parentSpanId()),
        layer: e.layer(),
        provider: str(e.provider()),
        model: str(e.model()),
        requestBody: str(e.requestBody()),
        attempt: e.attempt(),
      };
    }
    case REWIND_MSG.ModelResponse: {
      const e = ModelResponse.getRootAsModelResponse(bb);
      return {
        kind: 'ModelResponse',
        runId: e.runId() ?? '',
        spanId: str(e.spanId()),
        layer: e.layer(),
        status: e.status(),
        responseBody: str(e.responseBody()),
        error: str(e.error()),
        finishReason: str(e.finishReason()),
        inputTokens: e.inputTokens(),
        outputTokens: e.outputTokens(),
        latencyNs: e.latencyNs(),
      };
    }
    case REWIND_MSG.ToolCall: {
      const e = ToolCall.getRootAsToolCall(bb);
      return {
        kind: 'ToolCall',
        runId: e.runId() ?? '',
        spanId: str(e.spanId()),
        parentSpanId: str(e.parentSpanId()),
        layer: e.layer(),
        toolName: str(e.toolName()),
        input: str(e.input()),
      };
    }
    case REWIND_MSG.ToolResult: {
      const e = ToolResult.getRootAsToolResult(bb);
      return {
        kind: 'ToolResult',
        runId: e.runId() ?? '',
        spanId: str(e.spanId()),
        layer: e.layer(),
        status: e.status(),
        output: str(e.output()),
        error: str(e.error()),
        latencyNs: e.latencyNs(),
      };
    }
    case REWIND_MSG.RetryMarker: {
      const e = RetryMarker.getRootAsRetryMarker(bb);
      return {
        kind: 'RetryMarker',
        runId: e.runId() ?? '',
        spanId: str(e.spanId()),
        retryOfSpanId: str(e.retryOfSpanId()),
        attempt: e.attempt(),
      };
    }
    default:
      return null;
  }
}

// The causal tree: spans open on ModelRequest/ToolCall/RetryMarker, close on
// their span-matched response/result; children hang off parentSpanId. Same
// reconstruction the CLI's forensic replay performs — one fact model, two
// surfaces.
function buildTree(events: RewindEvent[]): RewindSpan[] {
  const spans = new Map<string, RewindSpan>();
  const order: string[] = [];
  for (const event of events) {
    if (!event.spanId) continue;
    if (
      event.kind === 'ModelRequest' ||
      event.kind === 'ToolCall' ||
      event.kind === 'RetryMarker'
    ) {
      spans.set(event.spanId, { spanId: event.spanId, open: event, children: [] });
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

export function openRewind(options: OpenRewindOptions): Rewind {
  const { binding } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);

  let cache: Map<string, RewindEvent[]> | null = null;

  const scan = (): Map<string, RewindEvent[]> => {
    const byRun = new Map<string, RewindEvent[]>();
    const assemble = new binding.Assemble([runtimeDir]);
    while (assemble.dataAvailable()) {
      const frame = assemble.currentFrame();
      const msgType = frame.msgType();
      if (msgType >= REWIND_MSG_MIN && msgType <= REWIND_MSG_MAX) {
        const decoded = decode(msgType, frame.dataBytes());
        if (decoded) {
          const event: RewindEvent = { ...decoded, genTime: frame.genTime() };
          const bucket = byRun.get(event.runId);
          if (bucket) bucket.push(event);
          else byRun.set(event.runId, [event]);
        }
      }
      assemble.next();
    }
    for (const events of byRun.values()) {
      events.sort((a, b) => (a.genTime < b.genTime ? -1 : a.genTime > b.genTime ? 1 : 0));
    }
    return byRun;
  };

  const ensure = () => {
    if (!cache) cache = scan();
    return cache;
  };

  const summarize = (runId: string, events: RewindEvent[]): RewindRunSummary => {
    const begin = events.find((e) => e.kind === 'RunBegin');
    const end = events.find((e) => e.kind === 'RunEnd');
    return {
      runId,
      command: begin?.command,
      beginTime: events[0]?.genTime ?? 0n,
      endTime: end?.genTime,
      runStatus: end?.runStatus,
      exitCode: end?.exitCode,
      eventCount: events.length,
      errorCount: events.filter((e) => e.status === CallStatus.Error).length,
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
      return { summary: summarize(runId, events), events, roots: buildTree(events) };
    },
  };
}
