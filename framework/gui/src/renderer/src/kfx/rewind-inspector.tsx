// Default kfx: the Rewind inspector — re-open recorded agent runs from the
// runtime home's trace journal and answer the diagnosis questions directly:
// which step failed, what went in, what came back. Three panes: run list,
// causal trace tree (cross-runtime spans included), node detail. Reads
// in-process through the rewind capability handle; no server, no upload.
import {
  CallStatus,
  type RewindEvent,
  type RewindRunSummary,
  type RewindSpan,
  RunStatus,
} from '@kungfu-tech/api/capability';
import React from 'react';
import type { KfxCapabilities, KfxManifest } from '../kfx';
import { headingStyle, mono, panelStyle } from '../ui';

const COLOR = {
  ok: '#4ec9b0',
  error: '#f48771',
  dim: '#858585',
  text: '#cccccc',
  accent: '#569cd6',
  retry: '#dcdcaa',
  selected: '#094771',
};

const nsToMs = (nanos?: bigint) =>
  nanos === undefined ? '' : `${(Number(nanos) / 1e6).toFixed(1)}ms`;

const clockTime = (nanos: bigint) => {
  const date = new Date(Number(nanos / 1_000_000n));
  return date.toLocaleTimeString('en-GB', { hour12: false });
};

function spanFailed(span: RewindSpan): boolean {
  if (span.close?.status === CallStatus.Error) return true;
  return span.children.some(spanFailed);
}

function spanLabel(span: RewindSpan): { head: string; color: string } {
  const { open, close, retry } = span;
  const suffix = retry ? ` (retry #${retry.attempt ?? '?'})` : '';
  if (open.kind === 'ModelRequest') {
    return {
      head: `model ${open.provider ?? '?'}/${open.model ?? '?'}${suffix}`,
      color: close?.status === CallStatus.Error ? COLOR.error : COLOR.accent,
    };
  }
  return {
    head: `tool ${open.toolName ?? '?'}${suffix}`,
    color:
      close?.status === CallStatus.Error
        ? COLOR.error
        : retry
          ? COLOR.retry
          : COLOR.ok,
  };
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: RewindRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const failed = run.runStatus === RunStatus.Failed || run.errorCount > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...mono,
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '4px 6px',
        border: 'none',
        width: '100%',
        textAlign: 'left',
        borderRadius: 4,
        cursor: 'pointer',
        color: COLOR.text,
        background: selected ? COLOR.selected : 'transparent',
      }}
    >
      <span style={{ color: failed ? COLOR.error : COLOR.ok }}>
        {failed ? '●' : '○'}
      </span>
      <span style={{ color: COLOR.text, whiteSpace: 'nowrap' }}>
        {run.runId.slice(0, 16)}
      </span>
      <span
        style={{ color: COLOR.dim, marginLeft: 'auto', whiteSpace: 'nowrap' }}
      >
        {run.eventCount} ev
        {run.errorCount > 0 ? ` · ${run.errorCount} err` : ''}
        {' · '}
        {clockTime(run.beginTime)}
      </span>
    </button>
  );
}

function TreeNode({
  span,
  depth,
  selectedSpan,
  onSelect,
}: {
  span: RewindSpan;
  depth: number;
  selectedSpan: string | null;
  onSelect: (span: RewindSpan) => void;
}) {
  const { head, color } = spanLabel(span);
  const failed = spanFailed(span);
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(span)}
        style={{
          ...mono,
          padding: '3px 6px',
          paddingLeft: 6 + depth * 16,
          border: 'none',
          width: '100%',
          textAlign: 'left',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          color: COLOR.text,
          background:
            selectedSpan === span.spanId ? COLOR.selected : 'transparent',
        }}
      >
        <span style={{ color: failed ? COLOR.error : COLOR.dim }}>
          {span.children.length > 0 ? '▾' : '·'}
        </span>
        <span style={{ color }}>{head}</span>
        {span.close?.status === CallStatus.Error ? (
          <span style={{ color: COLOR.error }}>✗</span>
        ) : null}
        <span style={{ color: COLOR.dim, marginLeft: 'auto' }}>
          {nsToMs(span.close?.latencyNs)}
        </span>
      </button>
      {span.children.map((child) => (
        <TreeNode
          key={child.spanId}
          span={child}
          depth={depth + 1}
          selectedSpan={selectedSpan}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function Body({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // keep raw
  }
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...headingStyle, margin: '0 0 4px 0' }}>{label}</div>
      <pre
        style={{
          ...mono,
          margin: 0,
          padding: 8,
          background: '#1e1e1e',
          border: '1px solid #3c3c3c',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 260,
          overflow: 'auto',
          color: COLOR.text,
        }}
      >
        {pretty}
      </pre>
    </div>
  );
}

function Fact({
  name,
  value,
  color,
}: { name: string; value?: React.ReactNode; color?: string }) {
  if (value === undefined || value === '' || value === null) return null;
  return (
    <div style={{ ...mono, display: 'flex', gap: 8, padding: '2px 0' }}>
      <span style={{ color: COLOR.dim, minWidth: 110 }}>{name}</span>
      <span style={{ color: color ?? COLOR.text, wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

function SpanDetail({ span }: { span: RewindSpan }) {
  const { open, close } = span;
  const failed = close?.status === CallStatus.Error;
  return (
    <div>
      <Fact
        name="status"
        value={close ? (failed ? 'error' : 'ok') : 'open'}
        color={failed ? COLOR.error : COLOR.ok}
      />
      <Fact name="span" value={span.spanId.slice(0, 16)} />
      <Fact name="parent" value={open.parentSpanId?.slice(0, 16)} />
      <Fact name="latency" value={nsToMs(close?.latencyNs)} />
      {open.kind === 'ModelRequest' ? (
        <>
          <Fact name="provider" value={open.provider} />
          <Fact name="model" value={open.model} />
          <Fact name="finish" value={close?.finishReason} />
          <Fact
            name="tokens"
            value={
              close?.inputTokens !== undefined
                ? `${close.inputTokens} in / ${close.outputTokens} out`
                : undefined
            }
          />
        </>
      ) : null}
      {open.kind === 'ToolCall' ? (
        <Fact name="tool" value={open.toolName} />
      ) : null}
      {span.retry ? (
        <>
          <Fact name="retry attempt" value={span.retry.attempt} />
          <Fact
            name="retry of"
            value={span.retry.retryOfSpanId?.slice(0, 16)}
          />
        </>
      ) : null}
      {close?.error ? (
        <Fact name="error" value={close.error} color={COLOR.error} />
      ) : null}
      <div style={{ height: 8 }} />
      <Body label="input" text={open.requestBody ?? open.input} />
      <Body label="output" text={close?.responseBody ?? close?.output} />
    </div>
  );
}

function RewindInspectorView({ caps }: { caps: KfxCapabilities }) {
  const { rewind } = caps;
  const [runs, setRuns] = React.useState<RewindRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = React.useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = React.useState<RewindSpan | null>(
    null,
  );
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(() => {
    try {
      rewind.refresh();
      const found = rewind.runs();
      setRuns(found);
      setSelectedRun((current) => current ?? found[0]?.runId ?? null);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [rewind]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const run = React.useMemo(() => {
    if (!selectedRun) return null;
    try {
      return rewind.loadRun(selectedRun);
    } catch {
      return null;
    }
  }, [rewind, selectedRun]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '300px 1fr 380px',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      <div style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <h3 style={headingStyle}>runs</h3>
          <button
            type="button"
            onClick={refresh}
            style={{
              ...mono,
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: COLOR.accent,
              cursor: 'pointer',
            }}
          >
            refresh
          </button>
        </div>
        {error ? (
          <div style={{ ...mono, color: COLOR.error }}>{error}</div>
        ) : null}
        {runs.length === 0 && !error ? (
          <div style={{ ...mono, color: COLOR.dim }}>
            no traced runs in this home — capture one with `kungfu trace -- …`
          </div>
        ) : null}
        {runs.map((r) => (
          <RunRow
            key={r.runId}
            run={r}
            selected={r.runId === selectedRun}
            onSelect={() => {
              setSelectedRun(r.runId);
              setSelectedSpan(null);
            }}
          />
        ))}
      </div>

      <div style={panelStyle}>
        <h3 style={headingStyle}>trace</h3>
        {run ? (
          <>
            <div style={{ ...mono, color: COLOR.dim, marginBottom: 8 }}>
              {run.summary.command ?? ''}
              {run.summary.exitCode !== undefined
                ? `  ·  exit ${run.summary.exitCode}`
                : ''}
            </div>
            {run.roots.map((span) => (
              <TreeNode
                key={span.spanId}
                span={span}
                depth={0}
                selectedSpan={selectedSpan?.spanId ?? null}
                onSelect={setSelectedSpan}
              />
            ))}
          </>
        ) : (
          <div style={{ ...mono, color: COLOR.dim }}>select a run</div>
        )}
      </div>

      <div style={panelStyle}>
        <h3 style={headingStyle}>node</h3>
        {selectedSpan ? (
          <SpanDetail span={selectedSpan} />
        ) : (
          <div style={{ ...mono, color: COLOR.dim }}>
            select a node — failed nodes are marked ✗
          </div>
        )}
      </div>
    </div>
  );
}

export const rewindInspectorKfx: KfxManifest = {
  id: 'rewind',
  title: 'Rewind',
  runtime: 'node-integrated',
  View: RewindInspectorView,
};
