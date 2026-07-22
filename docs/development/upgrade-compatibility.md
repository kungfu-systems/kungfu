# Upgrade compatibility reference

This reference describes the pre-release
`kungfu.product-upgrade.contract/v1`. The machine authority is
[`kungfu-upgrade.contract.json`](../../framework/upgrade/kungfu-upgrade.contract.json);
[ADR-0087](../adr/ADR-0087-versioned-product-runtime-upgrade-control-plane.md)
owns the architectural decision. The [upgrade guide](../guides/upgrading.md) owns
operator procedure.

## Authorities

| Decision | Authority |
| --- | --- |
| download and frontend transport | desktop or CLI distribution adapter |
| immutable runtime installation | runtime-image inventory |
| plan, selection, generation fence, activation, rollback, and collection | Core runtime-upgrade controller |
| semantic readiness | runtime readiness authority |
| durable workspace and Episode facts | yijinjing journal and Episode model |

Transport success is not activation evidence. A package manager, Electron installer,
or archive adapter may stage bytes but cannot select a live generation.

## Release identity

A release manifest binds:

- product version, release channel, source commit, platform, and architecture;
- runtime build id, complete runtime tree digest, and entrypoint;
- product frontend build id;
- control-protocol and peer-wire ranges;
- journal schema read range and write version;
- migration and rollback classes;
- minimum frontend and runtime support bounds;
- exact artifact URL, size, SHA-256 digest, and signing-evidence reference; and
- qualification evidence plus the documentation URL.

`kungfu.product.compatibility/v1` proves one assembled product came from coherent
source. It does not replace upgrade negotiation. The upgrade manifest separately
binds cross-time compatibility and runtime authority.

For standalone CLI archives, the declared byte size is an enforcement boundary as
well as identity evidence. Streaming stops before a partial file can grow past that
size, every manifest and artifact redirect target and resolved response must remain
HTTPS, and a resumed response must bind its exact start and total byte range to the
cached offset and manifest. Incomplete partials remain resumable; oversized partials
are discarded before a full restart, and complete digest-mismatched partials are
discarded before the caller retries. Direct apply checks size plus SHA-256 before
preview or extraction; execute copies the archive to an isolated snapshot and
rechecks the copy before validation and extraction, so later path replacement cannot
change the bytes receiving inventory authority. Archive metadata is also bounded to
100,000 entries and an expanded-byte budget of 200 times the verified archive size,
with a 64 MiB floor and an 8 GiB absolute ceiling. A candidate outside either bound
receives no inventory or runtime authority.

CLI image installation is side by side. Publishing `current.json` is separately
serialized inside one process and across host processes, and its selected product
version moves monotonically by SemVer. Out-of-order completion can retain an older
installed image for compatibility or rollback, but cannot move current authority
backward; equal product versions with different image evidence fail closed.

Download mutual exclusion is bound to the canonical cache target, not to a mutable
plan identity. Different plans that resolve to the same target therefore share one
process- and host-wide writer lock; each plan ID still independently fences the
requested artifact identity and its receipt.

## Compatibility decision

Core compares the target with the active image and live references:

| Field | Compatible when |
| --- | --- |
| control protocol | the target range contains the current protocol |
| peer wire protocol | the target range contains the current peer protocol |
| journal read | the target can read the current writer version |
| rollback read | the prior runtime can read the target writer version |
| migration | the declared class satisfies backup and approval requirements |
| provider continuity | any required resume is explicitly supported |

The result is a plan, not an implicit restart. `activeWorkContinues`,
`activationTiming`, and `userActionRequired` are machine-readable impact fields.

## States

| State | Contract meaning |
| --- | --- |
| `checking` | inspect release and current facts without changing authority |
| `download-allowed` | verified bytes may be installed; live routing is unchanged |
| `apply-now` | the installed target may stage now |
| `defer-until-idle` | incompatible active work keeps the target waiting |
| `compatible-handoff` | current work remains pinned while new work moves safely |
| `resume-required` | provider-supported new physical attempt is required |
| `blocked-incompatible` | safe continuation cannot be proved |
| `applying` | a fenced target generation is being staged |
| `reconciling` | semantic readiness is deciding commit or recovery |
| `complete` | the target is active or was already current |
| `failed-rolled-back` | readiness failed and the prior route was restored |
| `action-required` | safe automatic progress is impossible |

Desktop-only transport phases such as `available`, `downloading`, `downloaded`, and
`installer-handoff` are projections around these shared Core states. They do not add
activation authority.

## Reasons and documentation anchors

The welded `messageRegistry` contains one user explanation per shared reason. Each
record answers what happened, active-work impact, activation timing, the single user
action, data/session behavior, and an exact guide anchor.

| Reason | Meaning | Guide |
| --- | --- | --- |
| `target-not-installed` | verified target still needs side-by-side installation | [install](../guides/upgrading.md#download-and-install-without-interrupting-work) |
| `already-current` | selected runtime already matches | [status](../guides/upgrading.md#read-update-status) |
| `workspace-idle` | no active work blocks readiness | [activation](../guides/upgrading.md#when-the-new-runtime-takes-effect) |
| `active-work-compatible` | safe fenced handoff is possible | [active work](../guides/upgrading.md#updates-while-work-is-active) |
| `active-work-incompatible` | wait for idle | [active work](../guides/upgrading.md#updates-while-work-is-active) |
| `provider-resume-required` | supported new physical attempt is needed | [resume](../guides/upgrading.md#provider-resume-and-session-continuity) |
| `provider-resume-unsupported` | current provider work must finish or stop | [resume](../guides/upgrading.md#provider-resume-and-session-continuity) |
| `irreversible-migration-needs-approval` | recovery evidence and approval are absent | [migration](../guides/upgrading.md#irreversible-migrations) |
| `rollback-unavailable` | automatic return cannot be proved | [rollback](../guides/upgrading.md#rollback-and-recovery) |
| `stale-generation` | observed generation changed | [stale plan](../guides/upgrading.md#stale-plan-or-generation) |
| `readiness-failed` | target failed semantic readiness | [rollback](../guides/upgrading.md#rollback-and-recovery) |
| `unknown-image-reference` | image ownership is incomplete | [retention](../guides/upgrading.md#runtime-retention-and-cleanup) |
| `safe-to-collect` | no retained reference names the candidate | [retention](../guides/upgrading.md#runtime-retention-and-cleanup) |
| `downgrade-refused` | an older frontend cannot enter the normal update path | [downgrades](../guides/upgrading.md#downgrades-require-a-recovery-decision) |

Unknown reasons project the registry's `action-required` fallback and preserve the
original `reasonCode`. Surfaces therefore fail closed without losing diagnostics.

## Message schema

GUI and CLI project `kungfu.product-upgrade-message/v1`:

```json
{
  "schema": "kungfu.product-upgrade-message/v1",
  "reasonCode": "active-work-incompatible",
  "messageReasonCode": "active-work-incompatible",
  "title": "The update is waiting for current work",
  "whatHappened": "...",
  "activeWork": "...",
  "activation": "...",
  "userAction": "...",
  "dataAndSessions": "...",
  "impact": {
    "activeWorkContinues": true,
    "activationTiming": "after-safe-point",
    "userActionRequired": false
  },
  "documentationUrl": "https://www.kungfu.tech/docs/guides/upgrading#updates-while-work-is-active"
}
```

Human output may be shorter, but it must not contradict these fields. Technical
process details remain outside normal product messages.

## Qualification evidence

`qualificationEvidenceRef` and artifact `signature` strings are references, not
proof by themselves. Publication admission also consumes a separate
`kungfu.product-upgrade.qualification-evidence/v1` record. It must bind the same
source commit, product version, platform, architecture, runtime and frontend
surfaces, artifact digest, exact byte size, and signing-evidence reference.
The machine requirements live in the
[`kungfu.product-upgrade.qualification-contract/v1`](../../framework/upgrade/kungfu-upgrade-qualification.contract.json)
contract.

Every retained artifact row carries an Ed25519 public key and detached signature
over that canonical identity statement. Admission verifies the signature locally,
requires the `native-packaged` tier, all message/manual/runtime/adapter checks, and
at least 128 successful versioned-runtime churn iterations. Missing evidence,
source or artifact drift, a source-only tier, an invalid signature, an uncovered
surface, or an incomplete check fails with a stable qualification reason.

The native campaign for each platform must retain that record as
`product/release/qualification/kungfu-upgrade-qualification-evidence.json` inside
the platform payload. Before Buildchain writes custom publish evidence, Kungfu
reads the downloaded RC payloads, binds each manifest source to the RC passport,
requires exactly one Darwin, Linux, and Windows admission, verifies both Desktop
and CLI evidence, and recomputes the shipped Desktop/CLI byte size and SHA-256.
The default downloaded payload root is
`.buildchain/release-candidate/payloads`; controlled rehearsals may override it
with `KF_UPGRADE_PUBLISH_PAYLOAD_ROOT` and may override the RC passport path with
`KF_UPGRADE_RELEASE_CANDIDATE_PASSPORT`.

The contract currently records Darwin, Linux, and Windows as `source-fixture` and
`promotionEligible: false`. Real signed/notarized desktop artifacts, native package
campaigns, and cross-platform retained reports must close those blockers before a
release may claim a supported update channel.

## Migration and rollback classes

Migration classes are `none`, `reversible`, or `irreversible`. Rollback classes are
`automatic`, `manual`, or `unavailable`. An irreversible migration cannot stage
without verified backup or restore evidence and explicit user approval. A rollback
receipt changes runtime routing only; it never deletes workspace or Episode facts.

## Support and non-claims

The current contract is additive and pre-release. It does not claim:

- arbitrary in-process binary replacement;
- automatic irreversible migration;
- fabricated provider or PTY continuity;
- fleet, cross-host rolling update, HA, or distributed consensus;
- publication of official package-manager channels; or
- locally qualified cryptographic verification of release signature evidence.

Changing manifest identity, generation ownership, readiness commit, rollback fact
preservation, message semantics, or reference-aware collection requires an explicit
contract/versioning decision and updated qualification evidence.
