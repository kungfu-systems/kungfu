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

## CLI, GUI, and assembled-surface qualification

The surface gate first validates that every semantic GUI operation is wired to
the public storage capability and has a stable headless CLI expression:

```sh
./shifu layers:qualify:surfaces -- --validate-only
```

An exact local qualification consumes a standalone CLI archive and a packaged
desktop directory from the same build. It runs init/record/query/fsck/export
and agent discovery from the extracted headless artifact, rejects GUI/Electron
entries in that archive, compares the component compatibility manifest carried
by both products, and removes a GUI install projection before proving the
lower data root is byte-identical and still passes fsck:

```sh
./shifu layers:qualify:surfaces -- \
  --cli-archive product/release/cli/kungfu-episodes-cli-<platform>.tar.gz \
  --desktop-dir product/dist/desktop/<packaged-app-dir> \
  --report /tmp/kungfu-surface-qualification.json
```

This is exact directory-form evidence, not an installer-uninstall claim.
Publication, installer-specific behavior, other platforms, and resident-memory
budgets remain separate release gates.

## Ecosystem SDK qualification

The SDK gate uses one declarative semantic fixture and three deliberately thin
adapters. Python calls the storage service exposed by the wheel's native
binding, Node calls the same service through the packaged
`@kungfu-tech/storage` addon, and Rust owns the versioned C table through the
`kungfu-sdk` crate. The runner—not the adapters—owns the Episode/query/fsck/
export scenario, so a language package cannot quietly redefine semantics.

After building the exact wheel, npm main/platform archives, and staged native
directory, run:

```sh
./shifu layers:qualify:sdk -- --report /tmp/kungfu-sdk-qualification.json
```

Each package is installed into a separate clean ecosystem root. The report
binds artifact hashes, installed size, dependency count, first-call latency,
and sibling-runtime deletion proofs. A source-built passing report does not
claim that the artifact is published or qualified on unnamed platforms; those
remain release-channel evidence.
