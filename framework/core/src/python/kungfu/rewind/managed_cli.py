#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu managed-run` — run a provider CLI under Kungfu management and report
# its cost. This is the entry that joins the whole chain into one command:
# discover the provider, run it (managed_run), bracket the run on a real journal
# (RunBegin/CostSnapshot/RunEnd), finalize a trace bundle, and print the cost
# with its honest attribution label.
#
# It needs the native binding (the journal writer). Run it in the core dev
# environment (built dist/kungfu) or the packaged runtime.

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
import sys
import tempfile
import uuid
from typing import Any, Callable

import kungfu
from kungfu.rewind import (
    MSG_RUN_BEGIN,
    MSG_RUN_END,
    SCHEMA_VERSION,
    bundle,
    events,
    managed_run,
)
from kungfu.rewind.cost import confidence_for, discover_provider
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.skill import (
    build_skill_context,
    context_file_from_env,
    has_advertised_skills,
    has_context_envelope_info,
    inject_skill_context,
    load_skill_context_file,
    skill_advertised_event,
    skill_audit_document,
    write_audit_document,
)

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing


@dataclass
class ManagedRunCliReport:
    provider: str
    run_id: str
    exit_code: int
    response_path: str
    manifest_path: str
    response_doc: dict
    skill_audit_path: str | None
    skill_audit_doc: dict | None


def _open_journal(runtime_dir: str, run_id: str) -> Any:
    loc = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, loc
    )
    pub = yjj.noop_publisher()
    bus = yjj.bus(False)
    return yjj.writer(location, 0, True, pub, False, bus, 0)


def _rule(label: str = "") -> str:
    return f"─ {label} " + "─" * max(0, 44 - len(label))


def run_and_report(
    provider: str,
    prompt: str,
    *,
    runtime_dir: str,
    work_id: str | None = None,
    run_id: str | None = None,
    home: str | None = None,
    skill_paths: list[str] | None = None,
    skill_profile: str | None = None,
    agent: str | None = None,
    skill_context: bool = True,
    skill_context_file: str | None = None,
    skill_context_env: dict[str, str] | None = None,
    print_response: bool = False,
    report_callback: Callable[[ManagedRunCliReport], None] | None = None,
    quiet: bool = False,
) -> int:
    """Run one managed provider run on a journal under runtime_dir and print its
    cost. Returns the provider's exit code. Shared by the `kungfu managed-run`
    console command and the `python -m` entry."""
    # A caller that already owns the run (e.g. the GUI managed-session workspace)
    # injects run_id so the supervisor's cost/journal facts share one identity
    # with the on-screen session (W6 fact base); otherwise we mint one here.
    run_id = run_id or uuid.uuid4().hex[:12]

    disc = discover_provider(provider)
    if not quiet:
        print(
            f"\033[1m◆ Kungfu managed run\033[0m  provider={provider}  run_id={run_id}"
        )
    if not disc.found:
        if not quiet:
            print(f"  provider not available: {disc.error}")
        return 2
    # discover_provider sets path together with found; the guard above proves it
    assert disc.path is not None
    if not quiet:
        print(f"  binary  {disc.path}  ({disc.path_class}, {disc.version})")
    prompt_for_provider = prompt
    envelope = None
    skill_audit_events: list[Any] = []
    if skill_context:
        context_path = skill_context_file or context_file_from_env()
        if context_path:
            envelope = load_skill_context_file(context_path)
        else:
            envelope = build_skill_context(
                home or runtime_dir,
                source="cli",
                manager="python",
                profile=skill_profile,
                agent=agent or provider,
                extra_paths=skill_paths,
                runtime_dir=runtime_dir,
                env=skill_context_env,
            )
        if has_context_envelope_info(envelope):
            prompt_for_provider = inject_skill_context(prompt, envelope)
        if has_advertised_skills(envelope):
            skill_audit_events.append(
                skill_advertised_event(
                    envelope,
                    run_id=run_id,
                    provider=provider,
                    work_id=work_id,
                    context_file=context_path,
                )
            )

    if not quiet:
        print(f"  prompt  {prompt}")
        if envelope is not None and has_advertised_skills(envelope):
            print(
                "  skills  "
                f"{len(envelope['catalog'])} advertised  "
                f"{envelope['audit'].get('advertisedSkillsHash', 'sha256:unknown')}"
            )
        print("  running the provider under management …\n")

    writer = _open_journal(runtime_dir, run_id)

    def emit(msg_type: int, data: bytes) -> None:
        writer.write_bytes(0, msg_type, list(data), len(data))

    emit(
        MSG_RUN_BEGIN,
        events.run_begin(
            run_id=run_id,
            command=f"{provider} managed-run",
            runtime=sys.platform,
            supervisor_version=kungfu.__version__,
            schema_version=SCHEMA_VERSION,
        ),
    )

    result = managed_run.run_managed(
        provider,
        disc.path,
        prompt_for_provider,
        emit=emit,
        run_id=run_id,
        work_id=work_id,
    )

    status = RunStatus.Succeeded if result.exit_code == 0 else RunStatus.Failed
    emit(MSG_RUN_END, events.run_end(run_id, status, result.exit_code))
    # frames are written straight to the memory-mapped journal page, so they
    # persist without an explicit flush; the writer releases at function end.

    bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
    os.makedirs(bundle_dir, exist_ok=True)
    response_path = os.path.join(bundle_dir, "response.json")
    response_doc = {
        "schema": "kungfu.managed-run.response/v1",
        "run_id": run_id,
        "provider": provider,
        "exit_code": result.exit_code,
        "text": result.response_text,
        "body": json.loads(result.response_body) if result.response_body else None,
        "error": result.response_error,
    }
    with open(response_path, "w", encoding="utf-8") as f:
        json.dump(response_doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with open(response_path, "rb") as rf:
        response_hash = hashlib.sha256(rf.read()).hexdigest()
    skill_audit_doc = None
    skill_audit_path = None
    skill_audit_hash = None
    if skill_audit_events:
        skill_audit_path = os.path.join(bundle_dir, "skill-audit.json")
        skill_audit_doc = skill_audit_document(
            run_id=run_id,
            provider=provider,
            work_id=work_id,
            events=skill_audit_events,
        )
        skill_audit_hash = write_audit_document(skill_audit_path, skill_audit_doc)

    extra = {
        "managed_run_response": {
            "schema": response_doc["schema"],
            "path": "response.json",
            "sha256": response_hash,
            "text_known": result.response_text is not None,
            "error_known": result.response_error is not None,
        }
    }
    if skill_audit_doc:
        extra["skill_audit"] = {
            "schema": skill_audit_doc["schema"],
            "path": "skill-audit.json",
            "sha256": skill_audit_hash,
            "event_count": skill_audit_doc["event_count"],
            "event_types": sorted({row["type"] for row in skill_audit_events}),
        }
    manifest = bundle.emit(
        bundle_dir,
        runtime_dir,
        {
            "mode": "LIVE",
            "category": "SYSTEM",
            "group": "rewind",
            "name": run_id,
            "dest": 0,
        },
        extra=extra,
    )
    report = ManagedRunCliReport(
        provider=provider,
        run_id=run_id,
        exit_code=result.exit_code,
        response_path=response_path,
        manifest_path=manifest,
        response_doc=response_doc,
        skill_audit_path=skill_audit_path,
        skill_audit_doc=skill_audit_doc,
    )
    if report_callback is not None:
        report_callback(report)

    if quiet:
        return result.exit_code

    snap = result.snapshot
    print(_rule("cost"))
    if snap is not None and result.emitted:
        t = snap.tokens
        print(
            f"  provider     {snap.provider}   model {snap.model or '—'}   surface {snap.surface}"
        )
        print(
            f"  tokens       input {t.input_tokens}  output {t.output_tokens}  "
            f"cached {t.cached_input_tokens}  cache-write {t.cache_creation_input_tokens}  "
            f"reasoning {t.reasoning_tokens}"
        )
        if snap.cost_usd is not None:
            print(f"  cost         \033[1m${snap.cost_usd:.4f} USD\033[0m")
        else:
            print(
                "  cost         — no $ reported (tokens-only provider; cost_usd_known=false)"
            )
        ambiguous = "   \033[33mAMBIGUOUS\033[0m" if snap.ambiguous_attribution else ""
        print(
            f"  attribution  {snap.attribution.value}   confidence {confidence_for(snap.attribution)}{ambiguous}"
        )
        print("  event        CostSnapshot (msg_type 30008) written to the journal")
    else:
        print(
            f"  no cost reported   emitted={result.emitted}  exit={result.exit_code}"
            + (f"  error={result.error}" if result.error else "")
        )
    print(_rule("response"))
    print("  event        ModelResponse (msg_type 30004) written to the journal")
    print(f"  response     {response_path}")
    if result.response_text:
        first_line = result.response_text.splitlines()[0]
        print(f"  text         {first_line[:120]}")
    elif result.response_error:
        print(f"  error        {result.response_error[:120]}")
    else:
        print("  text         — no provider text field found")
    print(f"  run_id       {run_id}")
    print(f"  proof        {manifest}")
    if skill_audit_path:
        print(f"  skill_audit  {skill_audit_path}")
    print("─" * 46)
    if print_response and result.response_text:
        print(result.response_text)
    return result.exit_code


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kungfu managed-run")
    ap.add_argument(
        "--provider", required=True, choices=managed_run.managed_providers()
    )
    ap.add_argument("--prompt", required=True, help="the task to run")
    ap.add_argument("--home", default=None, help="runtime dir for the journal")
    ap.add_argument("--work-id", default=None, help="work item this run belongs to")
    ap.add_argument(
        "--run-id",
        default=None,
        help="run identity to bind cost/journal facts to (defaults to a fresh id)",
    )
    ap.add_argument(
        "--skill-path",
        action="append",
        default=[],
        help="skill directory or skill root to advertise to the agent",
    )
    ap.add_argument("--skill-profile", default=None, help="skill context profile")
    ap.add_argument("--agent", default=None, help="agent label for skill context")
    ap.add_argument(
        "--skill-context-file",
        default=None,
        help="prebuilt skill context envelope generated by a manager",
    )
    ap.add_argument(
        "--no-skill-context",
        action="store_true",
        help="disable Kungfu Skill context injection",
    )
    ap.add_argument(
        "--print-response",
        action="store_true",
        help="print the provider response text after the managed-run report",
    )
    args = ap.parse_args(argv)
    # Journal into the ambient runtime home so cost/journal facts land where the
    # rest of the runtime (e.g. the GUI session workspace's rewind reader) looks
    # for them. An explicit --home wins; a run launched inside a Kungfu runtime
    # inherits KF_RUNTIME_DIR; a truly standalone run falls back to a temp dir.
    runtime = (
        args.home
        or os.environ.get("KF_RUNTIME_DIR")
        or tempfile.mkdtemp(prefix="kungfu-managed-")
    )
    return run_and_report(
        args.provider,
        args.prompt,
        runtime_dir=runtime,
        work_id=args.work_id,
        run_id=args.run_id,
        home=runtime,
        skill_paths=args.skill_path,
        skill_profile=args.skill_profile,
        agent=args.agent,
        skill_context=not args.no_skill_context,
        skill_context_file=args.skill_context_file,
        print_response=args.print_response,
    )


if __name__ == "__main__":
    sys.exit(main())
