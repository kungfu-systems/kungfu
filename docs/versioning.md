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
| `kfx-contract` | kfx extension contract (package manifest schema, contribution points, trust tiers, load semantics, capability surface) | integration | [`../framework/kfx/kungfu-kfx.contract.json`](../framework/kfx/kungfu-kfx.contract.json), [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md), [ADR-0007](../framework/core/docs/adr/ADR-0007-v4-tui-platform-reference-surface.md), [ADR-0011](../framework/core/docs/adr/ADR-0011-v4-capability-sdk-contract.md), [ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md), [ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md), [ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md), [`extensions.md`](extensions.md), [`kfx-topology.md`](kfx-topology.md) |
| `skill-contract` | Kungfu Skill source, catalog, context envelope, audit, and kfx dependency binding | integration | [`../framework/skill/kungfu-skill.contract.json`](../framework/skill/kungfu-skill.contract.json), [ADR-0015](../framework/core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md), [`skills.md`](skills.md), [`../framework/skill/README.md`](../framework/skill/README.md) |
| `config-contract` | Kungfu global config contract: schema, defaults, resolution rules, resolved output metadata, and packaged contract hash | integration + cross-time | [`config.md`](config.md), [`../framework/config/kungfu-config.contract.json`](../framework/config/kungfu-config.contract.json) |
| `kungfu-cli` | kungfu CLI surface (canonical `kungfu` command; commands, journal subcommand output conventions) | integration | [`debugging.md`](debugging.md) |
| `journal-replayability` | cross-version cold-path decode of recorded journals | cross-time | [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md) |
| `v4-action-envelope` | Generic journal carrier for v4 runtime facts (`msg_type=1000`, semantics in `action_type` / `schema_ref`) | integration + cross-time | [`msg-type-ranges.md`](../framework/core/docs/msg-type-ranges.md), [ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md) |
| `rewind-event-schema` | Rewind capture event model (pre-envelope open-layer msg_types 30001-30099, `rewind_events.fbs`; trace bundles bind and outlive runs) | integration + cross-time | [`msg-type-ranges.md`](../framework/core/docs/msg-type-ranges.md), [`kungfu/rewind/README.md`](../framework/core/src/python/kungfu/rewind/README.md) |

A surface is registered when consumers bind to it at integration time without
runtime negotiation, or when its outputs remain depended on after the run.
Register changes are maintainer decisions and are logged below.

## Decision log

Line openings (minor/major), register changes, and deprecations are recorded
here, newest first. Patches are intentionally absent — silence means no
registered surface was touched.

| Date | Action | Line | Faces | Class | Rationale | PR |
|---|---|---|---|---|---|---|
| 2026-07-08 | register | — | v4-action-envelope | behavioral | Reset v4 business msg_type allocation: new runtime facts use `msg_type=1000` as the action-envelope carrier and put business semantics in `action_type` / `schema_ref`; Atlas import migrates off 30201-30205. Pre-release, no compatibility promise for the pre-envelope Atlas journal profile | — |
| 2026-07-06 | update | — | config-contract, kfx-contract, skill-contract | additive | Add a shared KFD-1 contract registry/runtime: config, kfx, and skill contracts are registry-addressed, copied into frozen artifacts by one tool, verified by one artifact hash gate, and inspectable through `kungfu contract`. Pre-release, no line open | — |
| 2026-07-06 | update | — | kfx-contract | additive | Weld the KFX manifest/config mechanism to a single machine-readable contract: package manifest schema, first-party manifest schema, Python/Node validation, frozen artifact hash evidence, and CLI inspection. Pre-release, no line open | — |
| 2026-07-06 | register | — | config-contract | additive | Register the Kungfu config contract as a KFD-1 welded surface: one source for schema/defaults/resolution rules, with resolved output and frozen artifact hash evidence. Pre-release, no line open | — |
| 2026-07-05 | update | — | kungfu-cli | additive | Rename the terminal reference-surface command `kungfu tui` → `kungfu cockpit` (an operator surface: monitor + config + mission ops). The Ink renderer stays the `tui` substrate (`framework/tui`, `@kungfu-tech/tui`, `tui.mjs`, `Resources/tui`); only the command/experience name changes. Pre-release, no line open | — |
| 2026-07-05 | register | — | skill-contract | additive | Register Kungfu Skills as their own integration surface above kfx: `SKILL.md` source, compact catalog/context envelope, audit sidecars, Node/Python manager equivalence, and kfx dependency binding. Pre-release, no line open | — |
| 2026-07-05 | update | — | kfx-contract | additive | Extend the registered kfx contract references from GUI/TUI view loading to the current trust/load topology: source authority, runtime-plane sandbox/trusted channel, uniform capability surface, and proposed dual-host/service facet. Pre-release, no line open | — |
| 2026-07-05 | update | — | kungfu-cli | additive | Fold the application-assembly SDK into the CLI as the `kungfu sdk` subcommand (was the standalone `kfs` command); extension/example builds now run `kungfu sdk kfx build`. Pre-release, no line open; `kfs` was never a registered surface | — |
| 2026-07-04 | update | — | rewind-event-schema | additive | Append `ApprovalDecision` (msg_type 30009): human approve/deny/interrupt/resume decision recorded as a run fact, `SCHEMA_VERSION` 2→3. Tail-only, existing 30001-30008 untouched |
| 2026-07-04 | update | — | rewind-event-schema | additive | Append `CostSnapshot` (msg_type 30008): normalized token/cost usage with attribution + confidence, `SCHEMA_VERSION` 1→2. Tail-only table, existing 30001-30007 untouched; old runs still decode through their own pinned `.bfbs` | — |
| 2026-07-02 | register | — | rewind-event-schema | additive | New face: Rewind capture event model as open-layer types (30001-30099) with per-run `.bfbs` manifest bindings; capture skeleton rides the frame header, semantics ride the tables. Nothing existing touched | — |
| 2026-07-02 | update | — | kungfu-cli (was kfc-cli) | additive | `kungfu` becomes the canonical CLI command, fronting the `kfc` runtime; `kfc` stays a working alias. Pre-release, no line open, nothing removed | #147 |
| 2026-07-02 | register | — | longfist-layout, capability-sdk-api, kfx-contract, kfc-cli, journal-replayability | additive | Initial register established on adopting KFD-1 (ADR-0010) | — |
