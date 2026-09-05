# Docker-first Hub Starter

The Hub Starter is currently a **concept-only** installed-product contract. It
defines what a future one-command Docker experience must preserve before Kungfu
creates a Compose bundle or publishes an image. The machine authority is
[`product/hub-starter/kungfu-hub-starter-docker.contract.json`](../../product/hub-starter/kungfu-hub-starter-docker.contract.json),
and the decision is
[KF-ADR-019f9388-a139-7355-b9f2-f6dd9aa91042](../adr/KF-ADR-019f9388-a139-7355-b9f2-f6dd9aa91042.md).

This slice does not contain a Dockerfile or Compose file, does not implement
`kungfu hub starter up`, and did not contact a Docker daemon. Its sole passing
evidence tier is static source-contract consistency.

## Responsibility boundary

| Surface | Owns | Does not own |
|---|---|---|
| Kungfu Hub Starter | product UX, exact-version assembly, safe defaults, lifecycle plans and receipts, volume/network projection | the Agent Hub protocol, a Hub implementation, or evidence it has not run |
| KFD Agent Hub profile and scaffold | envelope/profile vocabulary, four-language envelope smoke scaffolds, Hub 20 vectors, failure inventory and verifier | product lifecycle, persistence, deployment, or production readiness |
| `agent-hub-demo` | clean-room evidence that two independent file-CAS Hubs can consume public KFD | Kungfu product authority, durability, security, operations, or production fitness |
| Production Hub implementation | semantic behavior, state authority, supported image, security, backup/restore, upgrades and support | the right to weaken KFD or Kungfu gates |

The existing `kfd scaffold agent-hub` output remains deliberately small: it
proves envelope handling, not Hub 20. The existing installed-product
qualification proves one exact macOS arm64 Kungfu artifact against one exact
KFD alpha package. The Starter may compose these authorities; it may not
reinterpret or merge them.

## Target topology

The future default project contains one long-running `hub` service and one
opt-in, bounded `verify` job. Both run non-root with a read-only root
filesystem, no added Linux capabilities, no privileged mode, no host network,
and no Docker socket. A process being alive is not readiness; readiness
requires the product to open its authoritative state, hold the single-writer
fence, expose compatible capabilities, and write a semantic readiness receipt.

The default network is a private bridge with no public ports. Loopback
publication and outbound destinations require an explicit, content-addressed
plan. Container names, IDs, hostnames, IP addresses, and Compose display names
are routing hints, never Hub identity.

## State and identity

`hub-home` is the only authoritative writable Hub-state volume and has exactly
one writer. `qualification-evidence` is separate, append-only evidence owned by
the bounded verifier job. Anonymous volumes, host-path state, the real user
Home, destructive initialization, and automatic migration are forbidden by
default.

Hub identity is the workspace identity root plus an instance ID stored in the
explicit `hub-home`, the contract version, exact image digest, and volume
generation. First boot may mint an instance ID only on an empty explicit
volume. Restart preserves it. A clone must mint a new instance ID and retain a
provenance receipt.

## Lifecycle, upgrade, and recovery

The future command is `kungfu hub starter up`, but its v1 behavior is specified
before implementation:

1. render and validate an explicit project plan;
2. resolve an immutable image digest and exact compatibility tuple;
3. validate volume ownership, permissions, network exposure, and writer fence;
4. emit a content-addressed plan;
5. apply only the exact current plan, then wait for a semantic readiness
   receipt.

Unknown compatibility combinations and uncertain starts become `blocked`.
Upgrade is side-by-side plan, verify, then commit. Rollback retains the prior
image and untouched pre-commit volume generation. Downgrade is unsupported
unless that exact path is independently qualified.

Backup is a fenced consistent cut plus a complete manifest. Restore targets a
new empty volume, verifies member roots and identity policy, and reopens to a
semantic readiness receipt. In-place overwrite and automatic data repair are
not part of the Starter contract.

## Evidence ladder

| Tier | Current status | Required evidence before promotion | Bounded claim |
|---|---|---|---|
| concept-static | passed | schema, semantic checker, negative tests, docs links | source consistency only |
| compose-render | future | deterministic render, digest pins, policy lint | rendered topology only |
| daemon-smoke | future | fresh daemon, isolated volumes, readiness receipt | named-platform local start only |
| restart-and-fencing | future | restart, duplicate-writer rejection, uncertain-start fault | named-platform process recovery only |
| backup-restore | future | fresh-volume restore, root parity, fault injection | named campaign only |
| upgrade-rollback | future | previous-to-candidate campaign, commit fence, rollback parity | exact version pair only |
| production-admission | future | platform matrix, security review, operational SLO, release passport | bounded published profile only |

Each tier is monotonic in evidence, not in rhetoric. Passing a lower tier never
implies a higher one.

## Static verification

Run:

```sh
node scripts/check-hub-starter-docker-concept.mjs
node --test scripts/check-hub-starter-docker-concept.test.mjs
```

The checker validates the JSON Schema, all local authority paths, safe service
and volume defaults, exact evidence status, non-claims, ADR/documentation
links, and versioning registration. Its negative tests reject privilege,
Docker socket, host networking, public-port, floating-tag, real-Home,
multi-writer, premature CLI, daemon, and production overclaims.
