#  SPDX-License-Identifier: Apache-2.0
#
# The approval bridge: record a human's control decision on a managed run as a
# journal fact, and tell the session driver what to do to the process.
#
# Recording and executing are kept separate on purpose. This module owns the
# fact (an ApprovalDecision event, msg_type 30009) and the *intent* (a
# ControlAction); the caller — the GUI terminal capability or a pty session
# driver — performs the actual write/kill. That split keeps the decision
# auditable even if execution is out of this process (the GUI holds the pty),
# and keeps this layer testable without a real terminal.
#
# What this does NOT do: detect a provider's interactive approval prompt. Codex
# `exec --json` runs full-auto and Claude `--print` is non-interactive, so
# there is no prompt to answer there; real interactive approval lives in the
# providers' pty/TUI modes where the prompt text is provider- and
# version-specific. Parsing it is the approval frontier, deliberately out of
# scope here — a caller that knows its provider passes the exact response
# strings.

from dataclasses import dataclass
from typing import Callable, Optional

from kungfu.rewind import MSG_APPROVAL_DECISION, events
from kungfu.rewind.fb.Decision import Decision


# How a decision reaches the running process. The GUI wires kind=="signal" to
# terminal.kill(signal) and kind=="input" to terminal.write(data); kind=="none"
# means the decision is recorded but needs no process action.
@dataclass
class ControlAction:
    kind: str  # "signal" | "input" | "none"
    signal: Optional[str] = None
    data: Optional[str] = None


# Starting-point responses for an interactive prompt — NOT a contract. Real
# prompts vary by provider and version; a caller that knows its provider passes
# the exact strings. Interrupt maps to a signal, not input.
DEFAULT_APPROVE_INPUT = "y\n"
DEFAULT_DENY_INPUT = "n\n"
INTERRUPT_SIGNAL = "SIGINT"


def _action_for(decision, approve_input, deny_input, resume_input) -> ControlAction:
    if decision == Decision.Interrupt:
        return ControlAction("signal", signal=INTERRUPT_SIGNAL)
    if decision == Decision.Approve:
        return ControlAction("input", data=approve_input)
    if decision == Decision.Deny:
        return ControlAction("input", data=deny_input)
    if decision == Decision.Resume:
        # resume the run, optionally with follow-up input; empty means just
        # carry on without sending anything
        return ControlAction("input", data=resume_input or "")
    raise ValueError(f"unknown decision: {decision!r}")


def apply_decision(
    emit: Callable[[int, bytes], None],
    run_id: str,
    decision: int,
    *,
    request_id: Optional[str] = None,
    surface: str = "kungfu_gui",
    decided_by: str = "user",
    detail: Optional[str] = None,
    reason: Optional[str] = None,
    approve_input: str = DEFAULT_APPROVE_INPUT,
    deny_input: str = DEFAULT_DENY_INPUT,
    resume_input: Optional[str] = None,
) -> ControlAction:
    """Record an ApprovalDecision fact and return the control action to apply.

    The fact is recorded first — a human's decision is a fact whether or not the
    process is still there to receive it. `emit`'s (msg_type, bytes) signature is
    Supervisor.enqueue, so the decision lands on the same journal as the run.
    The returned ControlAction tells the session driver what to do: signal the
    process (Interrupt) or write input (Approve/Deny/Resume).
    """
    payload = events.approval_decision(
        run_id=run_id,
        decision=decision,
        request_id=request_id,
        surface=surface,
        decided_by=decided_by,
        detail=detail,
        reason=reason,
    )
    emit(MSG_APPROVAL_DECISION, payload)
    return _action_for(decision, approve_input, deny_input, resume_input)
