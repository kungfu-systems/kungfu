# Versioning — welded surfaces and the decision log

How this repository decides patch, minor, and major. The rule is
[KFD-1](https://github.com/kungfu-systems/kfd/blob/dev/v1/v1.0/decisions/kfd-0001-release-versioning.md)
(adopted by [ADR-0010](../framework/core/docs/adr/ADR-0010-adopt-kfd-1-release-versioning.md));
this document is the living register and decision log — it does not restate
the rule. For what each surface guarantees and how to verify it, see
[`contracts.md`](contracts.md); for how lines are opened and maintained, see
[`version-release-design.md`](version-release-design.md).

## Welded-surface register

| ID | Surface | Kind | Where it is specified |
|---|---|---|---|
| `longfist-layout` | longfist binary layout (in-memory == wire == on-disk) | integration + cross-time | [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md), [`contracts.md`](contracts.md) |
| `capability-sdk-api` | capability SDK surface (`framework/api`) | integration | [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md) |
| `kfx-contract` | kfx extension contract (contribution points, load semantics) | integration | [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md), [ADR-0007](../framework/core/docs/adr/ADR-0007-v4-tui-platform-reference-surface.md) |
| `kfc-cli` | kfc CLI surface (commands, journal subcommand output conventions) | integration | [`debugging.md`](debugging.md) |
| `journal-replayability` | cross-version cold-path decode of recorded journals | cross-time | [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md) |

A surface is registered when consumers bind to it at integration time without
runtime negotiation, or when its outputs remain depended on after the run.
Register changes are maintainer decisions and are logged below.

## Decision log

Line openings (minor/major), register changes, and deprecations are recorded
here, newest first. Patches are intentionally absent — silence means no
registered surface was touched.

| Date | Action | Line | Faces | Class | Rationale | PR |
|---|---|---|---|---|---|---|
| 2026-07-02 | register | — | longfist-layout, capability-sdk-api, kfx-contract, kfc-cli, journal-replayability | additive | Initial register established on adopting KFD-1 (ADR-0010) | — |
