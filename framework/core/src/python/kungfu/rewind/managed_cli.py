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

import argparse
import os
import sys
import tempfile
import uuid

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
    inject_skill_context,
    load_skill_context_file,
)

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing


def _open_journal(runtime_dir, run_id):
    loc = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, loc
    )
    pub = yjj.noop_publisher()
    bus = yjj.bus(False)
    return yjj.writer(location, 0, True, pub, False, bus, 0)


def _rule(label=""):
    return f"─ {label} " + "─" * max(0, 44 - len(label))


def run_and_report(
    provider,
    prompt,
    *,
    runtime_dir,
    work_id=None,
    home=None,
    skill_paths=None,
    skill_profile=None,
    agent=None,
    skill_context=True,
    skill_context_file=None,
):
    """Run one managed provider run on a journal under runtime_dir and print its
    cost. Returns the provider's exit code. Shared by the `kungfu managed-run`
    console command and the `python -m` entry."""
    run_id = uuid.uuid4().hex[:12]

    disc = discover_provider(provider)
    print(f"\033[1m◆ Kungfu managed run\033[0m  provider={provider}  run_id={run_id}")
    if not disc.found:
        print(f"  provider not available: {disc.error}")
        return 2
    print(f"  binary  {disc.path}  ({disc.path_class}, {disc.version})")
    prompt_for_provider = prompt
    envelope = None
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
            )
        if has_advertised_skills(envelope):
            prompt_for_provider = inject_skill_context(prompt, envelope)

    print(f"  prompt  {prompt}")
    if has_advertised_skills(envelope):
        print(
            "  skills  "
            f"{len(envelope['catalog'])} advertised  "
            f"{envelope['audit'].get('advertisedSkillsHash', 'sha256:unknown')}"
        )
    print("  running the provider under management …\n")

    writer = _open_journal(runtime_dir, run_id)

    def emit(msg_type, data):
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

    manifest = bundle.emit(
        os.path.join(runtime_dir, "rewind", run_id, "bundle"),
        runtime_dir,
        {
            "mode": "LIVE",
            "category": "SYSTEM",
            "group": "rewind",
            "name": run_id,
            "dest": 0,
        },
    )

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
    print(f"  run_id       {run_id}")
    print(f"  proof        {manifest}")
    print("─" * 46)
    return result.exit_code


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kungfu managed-run")
    ap.add_argument(
        "--provider", required=True, choices=managed_run.managed_providers()
    )
    ap.add_argument("--prompt", required=True, help="the task to run")
    ap.add_argument("--home", default=None, help="runtime dir for the journal")
    ap.add_argument("--work-id", default=None, help="work item this run belongs to")
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
    args = ap.parse_args(argv)
    runtime = args.home or tempfile.mkdtemp(prefix="kungfu-managed-")
    return run_and_report(
        args.provider,
        args.prompt,
        runtime_dir=runtime,
        work_id=args.work_id,
        home=runtime,
        skill_paths=args.skill_path,
        skill_profile=args.skill_profile,
        agent=args.agent,
        skill_context=not args.no_skill_context,
        skill_context_file=args.skill_context_file,
    )


if __name__ == "__main__":
    sys.exit(main())
