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


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kungfu managed-run")
    ap.add_argument(
        "--provider", required=True, choices=managed_run.managed_providers()
    )
    ap.add_argument("--prompt", required=True, help="the task to run")
    ap.add_argument("--home", default=None, help="runtime dir for the journal")
    ap.add_argument("--work-id", default=None, help="work item this run belongs to")
    args = ap.parse_args(argv)

    runtime = args.home or tempfile.mkdtemp(prefix="kungfu-managed-")
    run_id = uuid.uuid4().hex[:12]

    disc = discover_provider(args.provider)
    print(
        f"\033[1m◆ Kungfu managed run\033[0m  provider={args.provider}  run_id={run_id}"
    )
    if not disc.found:
        print(f"  provider not available: {disc.error}")
        return 2
    print(f"  binary  {disc.path}  ({disc.path_class}, {disc.version})")
    print(f"  prompt  {args.prompt}")
    print("  running the provider under management …\n")

    writer = _open_journal(runtime, run_id)

    def emit(msg_type, data):
        writer.write_bytes(0, msg_type, list(data), len(data))

    emit(
        MSG_RUN_BEGIN,
        events.run_begin(
            run_id=run_id,
            command=f"{args.provider} managed-run",
            runtime=sys.platform,
            supervisor_version=kungfu.__version__,
            schema_version=SCHEMA_VERSION,
        ),
    )

    result = managed_run.run_managed(
        args.provider,
        disc.path,
        args.prompt,
        emit=emit,
        run_id=run_id,
        work_id=args.work_id,
    )

    status = RunStatus.Succeeded if result.exit_code == 0 else RunStatus.Failed
    emit(MSG_RUN_END, events.run_end(run_id, status, result.exit_code))
    # frames are written straight to the memory-mapped journal page, so they
    # persist without an explicit flush; the writer releases at function end.

    manifest = bundle.emit(
        os.path.join(runtime, "rewind", run_id, "bundle"),
        runtime,
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


if __name__ == "__main__":
    sys.exit(main())
