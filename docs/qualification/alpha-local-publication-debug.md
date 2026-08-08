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
`SHA256SUMS` set, verifies every byte, and stages only the four installable
platform archives plus the minimum Passport, tail-plan, and candidate-receipt
members needed by the rehearsal capsule.

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
`/private/tmp/kungfu-alpha-phase-a/alpha-publication-debug`. Repeating the
exact command rewrites only that scratch directory and must reproduce the same
candidate, capsule, binding, transaction, state, evidence, and diagnostic
roots.

## Output and pass contract

`report.json` is the compact entry point. A pass requires:

- all 44 retained archives still match both manifests before and after the run;
- candidate source, tree, version, workflow run, Passport, tail plan, and
  receipt identities agree;
- the clean Buildchain checkout contains the protected streaming-hash repair;
- the shared Buildchain runtime accepts the reconstructed capsule and finishes
  every capability in `simulate` mode;
- `externalPublicationClaimed` is `false` and `inputUnchanged` is `true`.

The directory also retains `source-binding.json`, `rehearsal-capsule.json`,
`rehearsal-state.json`, `rehearsal-evidence.json`, and
`rehearsal-diagnostic.json`. On runtime rejection, the diagnostic uses
Buildchain's public error classifier and remains rooted to the capsule when
possible.

## Fail-closed boundaries

The command rejects relative or overlapping paths, missing or extra required
coordinates, dirty Buildchain checkouts, Buildchain history predating the
protected repair, symlinked candidate files, manifest or identity drift,
undeclared environment inputs, and any simulation that claims external
publication. It never supplies provider credentials or a provider adapter.

This phase proves local reconstruction and deterministic simulation for one
retained real candidate. Replay, fault injection, Ubuntu portability, and
hosted/local parity are separate continuation phases and are not implied by a
green Phase A report.
