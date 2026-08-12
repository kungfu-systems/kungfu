# Product upgrade publication admission

Kungfu qualifies product-specific upgrade behavior once, after every exact
platform payload, campaign record, candidate Passport, and credential-island
artifact is available, but before the candidate workflow can succeed. The
result is a rooted
`kungfu.product-upgrade.publication-admission/v1` receipt and a
`kungfu.product-upgrade.publication-candidate-capsule/v1` attachment. A failed
or missing receipt makes the candidate workflow non-successful, so Buildchain
cannot select it for publication.

The receipt binds source, tooling, candidate, artifact, platform, campaign,
policy, Passport, and credential roots across the exact five candidate bundles:
three upgrade-platform bundles, one Linux ARM64 support bundle, and one macOS
credential-island bundle. Later custom publish and signed Alpha
commit commands only verify the receipt, capsule, and current exact bytes. They
do not rerun Kungfu qualification. The receipt proves deterministic product
admission; it does not prove publication, notarization authority, attestation,
activation, or public readback.

## Produce and verify the receipt locally

After restoring the candidate payload artifacts and Passport under explicit
paths, run:

```sh
output_dir="$PWD/.buildchain/release-candidate/payloads/kungfu-product-upgrade-publication-admission"
./shifu node scripts/upgrade-publication-admission.mjs write \
  --payload-root "$PWD/.buildchain/release-candidate/payloads" \
  --passport "$PWD/.buildchain/release-candidate/passport/release-candidate-passport.json" \
  --version 4.0.0-alpha.1 \
  --output "$output_dir/product-upgrade-publication-admission.json" \
  --capsule "$output_dir/product-upgrade-publication-capsule.json"

./shifu node scripts/upgrade-publication-admission.mjs verify \
  --payload-root "$PWD/.buildchain/release-candidate/payloads" \
  --passport "$PWD/.buildchain/release-candidate/passport/release-candidate-passport.json" \
  --version 4.0.0-alpha.1 \
  --receipt "$output_dir/product-upgrade-publication-admission.json" \
  --capsule "$output_dir/product-upgrade-publication-capsule.json"
```

Use the exact candidate version; do not substitute a working-tree inference.
Any byte, manifest role, campaign, policy, Passport, credential evidence,
tooling, receipt, or capsule drift is a fresh-finalization requirement.

## Buildchain local constructibility

This flow consumes Buildchain's
[Release Local Constructibility and Runner Independence ADR](https://github.com/kungfu-systems/buildchain/blob/05a0e16b526393c7ea2999401c7198b27f37b1d3/architecture/decisions/0001-release-local-constructibility.md)
at the exact qualified protected `dev/v3/v3.0` head: every
non-external release behavior must be reconstructible from an explicit
content-addressed capsule without implicit GitHub runner state. Once the full
Buildchain rehearsal capsule has been restored, the normative local command is:

```sh
buildchain release-tail rehearse \
  --capsule "$PWD/.buildchain/publication/rehearsal-capsule.json" \
  --capsule-root "$PWD/.buildchain/publication/candidate" \
  --mode simulate \
  --state "$PWD/.buildchain/publication/rehearsal-state.json" \
  --evidence "$PWD/.buildchain/publication/rehearsal-evidence.json"
```

Simulation and replay evidence remain non-authoritative for external provider
effects. Preserve the candidate roots and diagnostic code when repairing a
deterministic failure.
