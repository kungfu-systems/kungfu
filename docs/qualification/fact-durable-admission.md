# Fact durable admission qualification

The normative source is
[`kungfu-fact-cut-kernel.contract.json`](../../framework/fact/kungfu-fact-cut-kernel.contract.json),
under `durableAdmission`. The active profile is
`fact-durable-admission/release-provenance-v1`. It is default-enabled only for
`ref-cas` names under `release-provenance/` and is production eligible only for
the `release-provenance-fact-cut-authority` scope. Ordinary refs and all other
Fact mutations preserve their explicit durability behavior.

The predecessor `fact-durable-admission/current-hardware-candidate-v1` report
is retained unchanged as an input. It remains default-off and non-production;
the new scoped qualification does not retroactively widen that report.

## Success frontier

A successful durable ref response binds:

- the original operation id and request root;
- the exact target Cut root and ref revision;
- the transitive stored content closure and separately named external roots;
- the adjacent journal record and accepted receipt sequences and roots;
- the file content-provider capability;
- the durable-ingest stream position, barrier, checkpoint, and evidence
  identity; and
- requested, admitted, effective, and achieved profiles.

The file content store is admitted because `yijinjing-file/v1` publishes with
`fsync-on-publish`. RocksDB `wal-os-buffered` is rejected before the ref write
because it cannot satisfy `durable_group` or `durable_sync`.

The journal sync and durable-ingest checkpoint are both required. A durable-log
copy of JSON alone is not journal durability, and an operation receipt cannot
self-certify a barrier.

## Unknown and reconciliation

Once a visible ref decision exists, any failure before returned success is
`outcome-unknown`. The caller must preserve the original operation id and call
`durability-reconcile`; changing identity is a different operation.

Fresh reopen returns the original accepted result only after verifying the
checkpoint-covered content closure, exact adjacent journal pair, ref Cut, and
revision. Missing checkpoint evidence remains unknown. It is never guessed as
failure or success.

## Portable authority qualification

The retained production report and portable bundle are
[`report.json`](evidence/durable-provenance-authority/v1/report.json) and
[`authority-bundle.json`](evidence/durable-provenance-authority/v1/authority-bundle.json).
They bind exact Alpha.1 and Alpha.2 semantic bodies, Versions, their
`acknowledges` relation, historical Cuts, durable refs, source closure, and the
native artifact used for qualification. Git commit, tree, parent, and branch
values are separately rooted projections and are not replay inputs.

Qualification exports from a fresh source runtime, verifies fsck, performs
dry-run and real import into a clean temporary runtime, verifies fsck again,
and compares pinned-Cut query roots. It then rehearses a durable rollback while
proving the newer Cut remains directly queryable. Tampered target roots,
missing bodies, and incomplete historical Cuts must all fail closed.

Generate the retained evidence explicitly:

```bash
./shifu durable-provenance-authority:qualify
./shifu check:durable-provenance-authority
```

The qualifier performs no Git or GitHub reads. Copy-based restoration never
mutates the source authority.

## Predecessor qualification and release gate

The retained report is
[`report.json`](evidence/fact-durable-admission/current-hardware-candidate-v1/report.json).
It binds the exact source set, native artifact, Linux/ext4/NVMe environment,
underlying durable-ingest admission report, provider matrix, every deterministic
cut point, checker, and residual risks.

Run the source and native gates through Shifu:

```bash
./shifu check:fact-cut-kernel-contract
./shifu check:fact-durable-admission
./shifu test:fact-kernel-native
./shifu test:durability-contract
```

To produce a successor retained report on the named disposable environment:

```bash
KUNGFU_FACT_QUALIFICATION_HOST_ENVELOPE=agent120-linux-x64-ext4-nvme-fact-v1 \
KUNGFU_FACT_QUALIFICATION_FILESYSTEM=ext4 \
KUNGFU_FACT_QUALIFICATION_DEVICE=<exact-nvme-device> \
KUNGFU_FACT_QUALIFICATION_KERNEL=<exact-kernel-release> \
./shifu fact-durable-admission:qualify -- \
  --output docs/qualification/evidence/fact-durable-admission/current-hardware-candidate-v1/report.json
```

Set `KUNGFU_FACT_QUALIFICATION_BINDING_DIR` only when a clean source worktree
must reuse an exact native `Release` binding built in another worktree on the
same qualification host. The report retains the conventional repository
artifact path and hashes the bytes from that explicit read-only directory.

Buildchain Release Passport continues to consume the general durability
contract through `durability.contracts`. Kungfu candidate, build, and promotion
workflows additionally execute `check:durable-provenance-authority`; none of
those active paths reconstruct historical meaning from Git ancestry or consume
the retired provenance dual-write artifacts.

## Known limits

- Deterministic process cut points do not qualify physical host power loss.
- The current report does not establish an independent failure domain.
- RocksDB `wal-os-buffered` is not admitted.
- Replication, high availability, consensus, malicious-administrator
  resistance, and general-purpose Fact production eligibility are not
  provided. Production eligibility is limited to the named release-provenance
  Fact/Cut authority scope.
- External declaration, admission, schema, Episode, omission, and conflict
  roots are bound as declared dependencies; they are not falsely represented as
  locally stored content.
