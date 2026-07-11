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

The `libkungfu` row is qualified by the native-storage capability slice rather
than by a workspace-package projection. `./shifu verify --full` builds a native
consumer with both language bindings disabled, then creates and reopens a
`.kungfu` workspace and completes Episode, head/historical query, fsck, and
export through the versioned C ABI. The dedicated three-platform native CI job
runs the same fixture and rejects Python, Node, Rust-host, Electron, and external
database dependencies in the consumer binary.

`./shifu check` runs this harness as a lightweight source gate. Later artifact
goals can add installed-artifact probes and release evidence without turning
this directory into another release orchestrator.
