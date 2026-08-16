# Product publication closure

Buildchain owns release-candidate construction, cross-platform verification,
attestation, Passport finalization, provider writes, and public readback. Kungfu
does not insert a second product-specific upgrade admission job between a
successful candidate build and that transaction.

The Alpha publication command consumes the sealed candidate Passport and
payloads supplied by Buildchain. It checks only Kungfu-owned publication
closure: the exact version and accepted source identity of the three public
release manifests, their asset metadata, the uploaded GitHub Release bytes,
the signed channel index, the installer publication bundle, and the KFD
evidence requested by the Buildchain contract. Runtime upgrade qualification
remains a source and product test; it is not a separate release-tail authority.

## Local rehearsal boundary

Use Buildchain rehearsal with the exact retained candidate to exercise every
non-provider tail step:

```sh
buildchain release-tail rehearse \
  --capsule "$PWD/.buildchain/publication/rehearsal-capsule.json" \
  --capsule-root "$PWD/.buildchain/publication/candidate" \
  --mode simulate \
  --state "$PWD/.buildchain/publication/rehearsal-state.json" \
  --evidence "$PWD/.buildchain/publication/rehearsal-evidence.json"
```

Simulation and replay evidence remain non-authoritative for external provider
effects. A tail retry must reuse the sealed candidate while source, tree,
Buildchain runtime, Passport, and artifact digests remain identical.
