# Local Alpha publication debugging

This runbook reconstructs the publication-tail inputs from the retained real
Alpha candidate at `~/Downloads/kungfu-alpha` and executes Buildchain's public
deterministic publication rehearsal core locally. It is a simulation and never
claims or performs external publication.

## Frozen candidate

The admitted fixture is GitHub Actions build run `31051528142`, source
`ad7c7db6df076f969c5939728bcbe70ccd4771b3`, tree
`67a93b5831596555e7c29104421de3a0b97eb865`, and version
`4.0.0-alpha.1`. The harness requires the exact 44-archive `artifacts.json` and
`SHA256SUMS` set and verifies every byte. The exact candidate stages the four
installable platform archives plus the minimum Passport, tail-plan, and
candidate-receipt members needed by the rehearsal capsule. It also binds the
source, policy roots, release-tail declaration, transaction, and provider
bindings as ordinary content-addressed files.

Credential or signing archives may be present in the retained artifact set,
but the harness does not open them. The artifact root, scratch root, and
Buildchain checkout must be explicit, absolute, real-path-resolved, and
pairwise disjoint.

## One command

Use a clean Buildchain `dev/v3/v3.0` checkout that contains protected merge
`fadcdfbf87a5e8f16b80df2ab39384dee0c8a601` or a descendant:

```sh
./shifu alpha:publication:debug -- \
  --artifact-root "$HOME/Downloads/kungfu-alpha" \
  --scratch-root /private/tmp/kungfu-alpha-phase-a \
  --buildchain-root /Users/dkr/Code/kungfu-systems/buildchain
```

The fixed output directory is
`/private/tmp/kungfu-alpha-phase-a/alpha-publication-debug`. Run from a clean
Kungfu checkout. Repeating the exact command preserves each already-materialized
candidate byte and must reproduce the same candidate inventory, capsule,
binding, transaction, state, evidence, and diagnostic roots. Existing candidate
bytes are never silently repaired: drift requires a new disposable scratch
root after the failed directory has been retained or discarded deliberately.

## Output and pass contract

`report.json` is the compact entry point. A pass requires:

- all 44 retained archives still match both manifests before and after the run;
- candidate source, tree, version, workflow run, Passport, tail plan, and
  receipt identities agree;
- the clean Buildchain checkout contains the protected streaming-hash repair;
- the shared Buildchain runtime accepts the reconstructed capsule and finishes
  every capability in `simulate` mode;
- `candidate-inventory.json` covers every regular file below `candidate/`, with
  no symbolic links, undeclared files, size drift, or SHA-256 drift;
- `externalPublicationClaimed` is `false` and `inputUnchanged` is `true`.

The directory also retains `source-binding.json`, `candidate-inventory.json`,
`rehearsal-capsule.json`, `rehearsal-state.json`, `rehearsal-evidence.json`,
and `rehearsal-diagnostic.json`. On any bounded validation or runtime rejection,
the diagnostic records a stable failure code and uses Buildchain's public error
classifier when available.

## Ubuntu portable smoke

Copy the complete `candidate/` directory and `rehearsal-capsule.json` without
changing bytes to a Linux worker, use a clean Buildchain checkout containing
the required protected merge, and bind the admitted Mac roots explicitly:

```sh
./shifu alpha:publication:debug:portable-smoke -- \
  --capsule /data/kungfu-alpha-debug/rehearsal-capsule.json \
  --capsule-root /data/kungfu-alpha-debug/candidate \
  --buildchain-root /data/worktrees/buildchain \
  --expected-binding-root sha256:<mac-binding-root> \
  --expected-transaction-root sha256:<mac-transaction-root>
```

The portable smoke performs no provider calls and accepts no credentials. A
pass means Linux re-read every capsule file and produced the same binding and
transaction roots; it does not claim native Linux product execution or any
hosted provider effect.

## Replay and fault qualification

Run the replay matrix over the already sealed candidate. The output root must
be separate from the candidate and Buildchain checkout; no candidate file is
copied, rewritten, or rebuilt:

```sh
./shifu alpha:publication:debug:replay -- \
  --capsule /private/tmp/kungfu-alpha-phase-a/alpha-publication-debug/rehearsal-capsule.json \
  --capsule-root /private/tmp/kungfu-alpha-phase-a/alpha-publication-debug/candidate \
  --scratch-root /private/tmp/kungfu-alpha-phase-c \
  --buildchain-root /Users/dkr/Code/kungfu-systems/buildchain
```

`alpha-publication-replay-qualification/report.json` binds every scenario to
the base capsule, complete candidate inventory, unchanged transaction, and
exact Buildchain checkout. The matrix records one transient-before-absent
sequence followed by a single apply and readback, an all-observed duplicate
with zero effects, a pre-effect immutable collision, bounded missing
post-effect observation, repeated settled and terminal replay, and two
identical fail-closed diagnostics for a tampered file entry. Every scenario
uses Buildchain's public `executePublicationRehearsal` core in `replay` mode;
recorded responses are data-only fixtures and never claim provider truth.

## Fail-closed boundaries

The command rejects relative or overlapping paths, missing or extra required
coordinates, dirty Buildchain checkouts, Buildchain history predating the
protected repair, symlinked candidate files, manifest or identity drift,
undeclared environment inputs, and any simulation that claims external
publication. It never supplies provider credentials or a provider adapter.

Phase A proved local reconstruction and deterministic simulation for one
retained real candidate. Phase B adds the sealed complete-file inventory,
stable clean-checkout workflow, and portable non-provider smoke. Phase C adds
bounded replay and fault qualification without rebuilding artifacts. Hosted
provider effects and hosted/local parity remain a separate continuation phase
and are not implied by a green local report.
