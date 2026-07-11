# ADR-0049 layer qualification harness

This harness turns ADR-0049's qualification matrix into a small, executable
contract. It deliberately separates two facts:

- the harness can be valid and its fixtures can pass;
- individual release artifacts can still be `absent`, `staged`, `failing`, or
  `unverifiable`.

Run it through the pinned toolchain:

```sh
./shifu layers:qualify
./shifu layers:qualify -- --report /tmp/kungfu-layer-qualification.json
```

`artifact-matrix.json` declares every official layer, its closure,
capabilities, forbidden dependencies, onboarding concepts, and current status.
The runner records exact Git/platform facts and source-level dependency and
concept baselines. Installed size, cold start, resident runtimes, and resident
memory stay `unverifiable` until a later goal supplies an exact installed
artifact; source-tree size is not silently substituted for installed size.

The first deletion fixture starts from the real workspace manifests, computes
the CLI/TUI runtime dependency closure, writes that closure into an isolated
temporary projection with the GUI package omitted, and resolves it again. It
proves only the source-level dependency boundary: it does not claim that the
packaged CLI already passes clean-install or runtime qualification.

`./shifu check` runs this harness as a lightweight source gate. Later artifact
goals can add installed-artifact probes and release evidence without turning
this directory into another release orchestrator.
