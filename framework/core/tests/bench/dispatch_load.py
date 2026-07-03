# SPDX-License-Identifier: Apache-2.0
#
# Load generator for the event-dispatch latency baseline (ADR-0005 evidence).
#
# Registers a plain apprentice against a running master in the same KF_HOME,
# waits for the register handshake to grant the PUBLIC writer, then writes a
# burst of open-layer events into its own journal. The master joins this
# journal on register, so every frame written here traverses the master's
# full rx filter-chain set; the KF_DISPATCH_PROBE instrument in hero::drain
# reports the per-frame traversal cost on the master side.
#
# Usage: dispatch_load.py <kf-home> <event-count> [payload-bytes] [msg-type]
#
# msg-type accepts a number (written via write_bytes as an open-layer event)
# or the literal "quote" (writes typed longfist Quote frames — these pass the
# node watcher's is_reactable pre-filter and exercise its state-bank feed,
# unlike open-layer events which the watcher pre-filters out).
#
# Runs inside the dev kfc environment (needs pykungfu); bootstraps its own
# sys.path the same way the capture fixtures do.

import os
import sys
import time

_core = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kfc"))

import kungfu

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

PUBLIC_DEST = 0
# Open layer starts at 30001 (see msg-type range registry); no longfist tag,
# so on the master side every is(tag) chain rejects it and the cost measured
# is the pure chain scan plus the instanceof feed chain.
DEFAULT_MSG_TYPE = 30001
STEP_TIMEOUT_SECONDS = 30


class LoadApp(yjj.apprentice):
    def on_exit(self):
        pass


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    home = sys.argv[1]
    count = int(sys.argv[2])
    payload_bytes = int(sys.argv[3]) if len(sys.argv) > 3 else 64
    raw_type = sys.argv[4] if len(sys.argv) > 4 else str(DEFAULT_MSG_TYPE)
    use_quote = raw_type == "quote"
    msg_type = lf.types.Quote.__tag__ if use_quote else int(raw_type)

    runtime_dir = os.path.join(home, "runtime")
    locator = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.category.STRATEGY,
        "bench",
        "dispatch_load",
        locator,
    )

    app = LoadApp(location, True)  # low_latency: busy-poll, no observer sleep
    app.setup()

    deadline = time.time() + STEP_TIMEOUT_SECONDS
    while not (app.is_started() and app.has_writer(PUBLIC_DEST)):
        app.step(1000)
        if time.time() > deadline:
            sys.exit("register handshake timed out; is master running?")

    writer = app.get_writer(PUBLIC_DEST)
    payload = [0] * payload_bytes  # binding takes list[int] (vector<uint8_t>)
    quote = lf.types.Quote() if use_quote else None
    started_at = time.time()
    for i in range(count):
        if use_quote:
            writer.write(yjj.now_in_nano(), quote)
        else:
            writer.write_bytes(yjj.now_in_nano(), msg_type, payload, payload_bytes)
        if i % 10000 == 0:
            app.step(100)  # keep consuming master feedback while loading
    elapsed = time.time() - started_at

    # Let the reader side finish draining, then send a small tail burst: the
    # probe reports at most every 5 seconds and only while dispatching, so a
    # short main burst alone can end before a report tick ever fires. The
    # tail burst lands after the 5s window and flushes the cumulative stats.
    settle_until = time.time() + 6
    while time.time() < settle_until:
        app.step(1000)
        time.sleep(0.01)
    for _ in range(max(1000, count // 100)):
        if use_quote:
            writer.write(yjj.now_in_nano(), quote)
        else:
            writer.write_bytes(yjj.now_in_nano(), msg_type, payload, payload_bytes)
    settle_until = time.time() + 2
    while time.time() < settle_until:
        app.step(1000)
        time.sleep(0.01)

    rate = count / elapsed if elapsed > 0 else float("inf")
    print(
        f"dispatch_load done: {count} events x {payload_bytes}B "
        f"msg_type={msg_type} written in {elapsed:.2f}s ({rate:,.0f}/s)"
    )


if __name__ == "__main__":
    main()
