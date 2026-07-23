#  SPDX-License-Identifier: Apache-2.0
#
# Serializers: python values -> FlatBuffers event bytes, ready for
# writer.write_bytes(...). One function per event table; string fields are
# optional throughout (the schema forbids `required`), so None simply omits
# the field.

from __future__ import annotations

import flatbuffers

from kungfu.rewind.fb import (
    ApprovalDecision,
    CostSnapshot,
    ModelRequest,
    ModelResponse,
    RetryMarker,
    RunBegin,
    RunEnd,
    RunProgress,
    ToolCall,
    ToolResult,
)


def _s(builder: flatbuffers.Builder, value: str | None) -> int | None:
    return builder.CreateString(value) if value else None


def run_begin(
    run_id: str | None,
    command: str | None,
    runtime: str | None,
    supervisor_version: str | None,
    schema_version: int,
) -> bytes:
    b = flatbuffers.Builder(256)
    run_id_o = _s(b, run_id)
    command_o = _s(b, command)
    runtime_o = _s(b, runtime)
    version_o = _s(b, supervisor_version)
    RunBegin.Start(b)
    if run_id_o:
        RunBegin.AddRunId(b, run_id_o)
    if command_o:
        RunBegin.AddCommand(b, command_o)
    if runtime_o:
        RunBegin.AddRuntime(b, runtime_o)
    if version_o:
        RunBegin.AddSupervisorVersion(b, version_o)
    RunBegin.AddSchemaVersion(b, schema_version)
    b.Finish(RunBegin.End(b))
    return bytes(b.Output())


def run_end(run_id: str | None, status: int, exit_code: int) -> bytes:
    b = flatbuffers.Builder(64)
    run_id_o = _s(b, run_id)
    RunEnd.Start(b)
    if run_id_o:
        RunEnd.AddRunId(b, run_id_o)
    RunEnd.AddStatus(b, status)
    RunEnd.AddExitCode(b, exit_code)
    b.Finish(RunEnd.End(b))
    return bytes(b.Output())


def run_progress(
    run_id: str | None,
    phase: str | None,
    message: str | None,
    severity: str | None = None,
    pct: int = 0,
    detail: str | None = None,
    signal: str | None = None,
    next_action: str | None = None,
    workspace_id: str | None = None,
    profile_id: str | None = None,
    profile_root: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    entity_root: str | None = None,
) -> bytes:
    b = flatbuffers.Builder(256)
    run_id_o = _s(b, run_id)
    phase_o = _s(b, phase)
    message_o = _s(b, message)
    severity_o = _s(b, severity)
    detail_o = _s(b, detail)
    signal_o = _s(b, signal)
    next_action_o = _s(b, next_action)
    workspace_id_o = _s(b, workspace_id)
    profile_id_o = _s(b, profile_id)
    profile_root_o = _s(b, profile_root)
    entity_type_o = _s(b, entity_type)
    entity_id_o = _s(b, entity_id)
    entity_root_o = _s(b, entity_root)
    RunProgress.Start(b)
    if run_id_o:
        RunProgress.AddRunId(b, run_id_o)
    if phase_o:
        RunProgress.AddPhase(b, phase_o)
    if message_o:
        RunProgress.AddMessage(b, message_o)
    if severity_o:
        RunProgress.AddSeverity(b, severity_o)
    RunProgress.AddPct(b, pct)
    if detail_o:
        RunProgress.AddDetail(b, detail_o)
    if signal_o:
        RunProgress.AddSignal(b, signal_o)
    if next_action_o:
        RunProgress.AddNextAction(b, next_action_o)
    if workspace_id_o:
        RunProgress.AddWorkspaceId(b, workspace_id_o)
    if profile_id_o:
        RunProgress.AddProfileId(b, profile_id_o)
    if profile_root_o:
        RunProgress.AddProfileRoot(b, profile_root_o)
    if entity_type_o:
        RunProgress.AddEntityType(b, entity_type_o)
    if entity_id_o:
        RunProgress.AddEntityId(b, entity_id_o)
    if entity_root_o:
        RunProgress.AddEntityRoot(b, entity_root_o)
    b.Finish(RunProgress.End(b))
    return bytes(b.Output())


def model_request(
    run_id: str | None,
    span_id: str | None,
    parent_span_id: str | None,
    layer: int,
    provider: str | None,
    model: str | None,
    request_body: str | None,
    attempt: int = 0,
) -> bytes:
    b = flatbuffers.Builder(1024)
    run_id_o = _s(b, run_id)
    span_o = _s(b, span_id)
    parent_o = _s(b, parent_span_id)
    provider_o = _s(b, provider)
    model_o = _s(b, model)
    body_o = _s(b, request_body)
    ModelRequest.Start(b)
    if run_id_o:
        ModelRequest.AddRunId(b, run_id_o)
    if span_o:
        ModelRequest.AddSpanId(b, span_o)
    if parent_o:
        ModelRequest.AddParentSpanId(b, parent_o)
    ModelRequest.AddLayer(b, layer)
    if provider_o:
        ModelRequest.AddProvider(b, provider_o)
    if model_o:
        ModelRequest.AddModel(b, model_o)
    if body_o:
        ModelRequest.AddRequestBody(b, body_o)
    ModelRequest.AddAttempt(b, attempt)
    b.Finish(ModelRequest.End(b))
    return bytes(b.Output())


def model_response(
    run_id: str | None,
    span_id: str | None,
    layer: int,
    status: int,
    response_body: str | None,
    error: str | None = None,
    finish_reason: str | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    latency_ns: int = 0,
) -> bytes:
    b = flatbuffers.Builder(1024)
    run_id_o = _s(b, run_id)
    span_o = _s(b, span_id)
    body_o = _s(b, response_body)
    error_o = _s(b, error)
    finish_o = _s(b, finish_reason)
    ModelResponse.Start(b)
    if run_id_o:
        ModelResponse.AddRunId(b, run_id_o)
    if span_o:
        ModelResponse.AddSpanId(b, span_o)
    ModelResponse.AddLayer(b, layer)
    ModelResponse.AddStatus(b, status)
    if body_o:
        ModelResponse.AddResponseBody(b, body_o)
    if error_o:
        ModelResponse.AddError(b, error_o)
    if finish_o:
        ModelResponse.AddFinishReason(b, finish_o)
    ModelResponse.AddInputTokens(b, input_tokens)
    ModelResponse.AddOutputTokens(b, output_tokens)
    ModelResponse.AddLatencyNs(b, latency_ns)
    b.Finish(ModelResponse.End(b))
    return bytes(b.Output())


def tool_call(
    run_id: str | None,
    span_id: str | None,
    parent_span_id: str | None,
    layer: int,
    tool_name: str | None,
    input_body: str | None,
) -> bytes:
    b = flatbuffers.Builder(512)
    run_id_o = _s(b, run_id)
    span_o = _s(b, span_id)
    parent_o = _s(b, parent_span_id)
    name_o = _s(b, tool_name)
    input_o = _s(b, input_body)
    ToolCall.Start(b)
    if run_id_o:
        ToolCall.AddRunId(b, run_id_o)
    if span_o:
        ToolCall.AddSpanId(b, span_o)
    if parent_o:
        ToolCall.AddParentSpanId(b, parent_o)
    ToolCall.AddLayer(b, layer)
    if name_o:
        ToolCall.AddToolName(b, name_o)
    if input_o:
        ToolCall.AddInput(b, input_o)
    b.Finish(ToolCall.End(b))
    return bytes(b.Output())


def tool_result(
    run_id: str | None,
    span_id: str | None,
    layer: int,
    status: int,
    output: str | None,
    error: str | None = None,
    latency_ns: int = 0,
) -> bytes:
    b = flatbuffers.Builder(512)
    run_id_o = _s(b, run_id)
    span_o = _s(b, span_id)
    output_o = _s(b, output)
    error_o = _s(b, error)
    ToolResult.Start(b)
    if run_id_o:
        ToolResult.AddRunId(b, run_id_o)
    if span_o:
        ToolResult.AddSpanId(b, span_o)
    ToolResult.AddLayer(b, layer)
    ToolResult.AddStatus(b, status)
    if output_o:
        ToolResult.AddOutput(b, output_o)
    if error_o:
        ToolResult.AddError(b, error_o)
    ToolResult.AddLatencyNs(b, latency_ns)
    b.Finish(ToolResult.End(b))
    return bytes(b.Output())


def cost_snapshot(
    run_id: str | None,
    work_id: str | None,
    session_id: str | None,
    layer: int,
    provider: str | None,
    surface: str | None,
    model: str | None,
    source: str | None,
    attribution: int,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    reasoning_tokens: int = 0,
    cost_usd: float = 0.0,
    cost_usd_known: bool = False,
    ambiguous_attribution: bool = False,
    raw_ref: str | None = None,
) -> bytes:
    # cost_usd is only meaningful when cost_usd_known is True; a tokens-only
    # provider passes cost_usd_known=False and the 0.0 is a placeholder, not a
    # claim the run was free. The bridge in cost/wire.py enforces that pairing.
    b = flatbuffers.Builder(512)
    run_id_o = _s(b, run_id)
    work_o = _s(b, work_id)
    session_o = _s(b, session_id)
    provider_o = _s(b, provider)
    surface_o = _s(b, surface)
    model_o = _s(b, model)
    source_o = _s(b, source)
    raw_ref_o = _s(b, raw_ref)
    CostSnapshot.Start(b)
    if run_id_o:
        CostSnapshot.AddRunId(b, run_id_o)
    if work_o:
        CostSnapshot.AddWorkId(b, work_o)
    if session_o:
        CostSnapshot.AddSessionId(b, session_o)
    CostSnapshot.AddLayer(b, layer)
    if provider_o:
        CostSnapshot.AddProvider(b, provider_o)
    if surface_o:
        CostSnapshot.AddSurface(b, surface_o)
    if model_o:
        CostSnapshot.AddModel(b, model_o)
    if source_o:
        CostSnapshot.AddSource(b, source_o)
    CostSnapshot.AddAttribution(b, attribution)
    CostSnapshot.AddInputTokens(b, input_tokens)
    CostSnapshot.AddOutputTokens(b, output_tokens)
    CostSnapshot.AddCachedInputTokens(b, cached_input_tokens)
    CostSnapshot.AddCacheCreationInputTokens(b, cache_creation_input_tokens)
    CostSnapshot.AddReasoningTokens(b, reasoning_tokens)
    CostSnapshot.AddCostUsd(b, cost_usd)
    CostSnapshot.AddCostUsdKnown(b, cost_usd_known)
    CostSnapshot.AddAmbiguousAttribution(b, ambiguous_attribution)
    if raw_ref_o:
        CostSnapshot.AddRawRef(b, raw_ref_o)
    b.Finish(CostSnapshot.End(b))
    return bytes(b.Output())


def approval_decision(
    run_id: str | None,
    decision: int,
    request_id: str | None = None,
    surface: str | None = None,
    decided_by: str | None = None,
    detail: str | None = None,
    reason: str | None = None,
) -> bytes:
    b = flatbuffers.Builder(256)
    run_id_o = _s(b, run_id)
    request_o = _s(b, request_id)
    surface_o = _s(b, surface)
    decided_by_o = _s(b, decided_by)
    detail_o = _s(b, detail)
    reason_o = _s(b, reason)
    ApprovalDecision.Start(b)
    if run_id_o:
        ApprovalDecision.AddRunId(b, run_id_o)
    if request_o:
        ApprovalDecision.AddRequestId(b, request_o)
    ApprovalDecision.AddDecision(b, decision)
    if surface_o:
        ApprovalDecision.AddSurface(b, surface_o)
    if decided_by_o:
        ApprovalDecision.AddDecidedBy(b, decided_by_o)
    if detail_o:
        ApprovalDecision.AddDetail(b, detail_o)
    if reason_o:
        ApprovalDecision.AddReason(b, reason_o)
    b.Finish(ApprovalDecision.End(b))
    return bytes(b.Output())


def retry_marker(
    run_id: str | None,
    span_id: str | None,
    retry_of_span_id: str | None,
    attempt: int,
    reason: str | None = None,
) -> bytes:
    b = flatbuffers.Builder(128)
    run_id_o = _s(b, run_id)
    span_o = _s(b, span_id)
    retry_of_o = _s(b, retry_of_span_id)
    reason_o = _s(b, reason)
    RetryMarker.Start(b)
    if run_id_o:
        RetryMarker.AddRunId(b, run_id_o)
    if span_o:
        RetryMarker.AddSpanId(b, span_o)
    if retry_of_o:
        RetryMarker.AddRetryOfSpanId(b, retry_of_o)
    RetryMarker.AddAttempt(b, attempt)
    if reason_o:
        RetryMarker.AddReason(b, reason_o)
    b.Finish(RetryMarker.End(b))
    return bytes(b.Output())
