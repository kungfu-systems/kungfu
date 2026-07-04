#  SPDX-License-Identifier: Apache-2.0
#
# Serializers: python values -> FlatBuffers event bytes, ready for
# writer.write_bytes(...). One function per event table; string fields are
# optional throughout (the schema forbids `required`), so None simply omits
# the field.

import flatbuffers

from kungfu.rewind.fb import (
    CostSnapshot,
    ModelRequest,
    ModelResponse,
    RetryMarker,
    RunBegin,
    RunEnd,
    ToolCall,
    ToolResult,
)


def _s(builder, value):
    return builder.CreateString(value) if value else None


def run_begin(run_id, command, runtime, supervisor_version, schema_version):
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


def run_end(run_id, status, exit_code):
    b = flatbuffers.Builder(64)
    run_id_o = _s(b, run_id)
    RunEnd.Start(b)
    if run_id_o:
        RunEnd.AddRunId(b, run_id_o)
    RunEnd.AddStatus(b, status)
    RunEnd.AddExitCode(b, exit_code)
    b.Finish(RunEnd.End(b))
    return bytes(b.Output())


def model_request(
    run_id, span_id, parent_span_id, layer, provider, model, request_body, attempt=0
):
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
    run_id,
    span_id,
    layer,
    status,
    response_body,
    error=None,
    finish_reason=None,
    input_tokens=0,
    output_tokens=0,
    latency_ns=0,
):
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


def tool_call(run_id, span_id, parent_span_id, layer, tool_name, input_body):
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


def tool_result(run_id, span_id, layer, status, output, error=None, latency_ns=0):
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
    run_id,
    work_id,
    session_id,
    layer,
    provider,
    surface,
    model,
    source,
    attribution,
    input_tokens=0,
    output_tokens=0,
    cached_input_tokens=0,
    cache_creation_input_tokens=0,
    reasoning_tokens=0,
    cost_usd=0.0,
    cost_usd_known=False,
    ambiguous_attribution=False,
    raw_ref=None,
):
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


def retry_marker(run_id, span_id, retry_of_span_id, attempt, reason=None):
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
