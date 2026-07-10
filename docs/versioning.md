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
| `yijinjing-schema-layout` | yijinjing schema binary layout (v4 greenfield root; v4+ compatibility surface after stable release) | integration + cross-time | [ADR-0008](../framework/core/docs/adr/ADR-0008-yijinjing-schema-layout-baseline.md), [`contracts.md`](contracts.md) |
| `capability-sdk-api` | capability SDK surface (`framework/api`) | integration | [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md) |
| `kfx-contract` | kfx extension contract (package manifest schema, contribution points, trust tiers, load semantics, capability surface) | integration | [`../framework/kfx/kungfu-kfx.contract.json`](../framework/kfx/kungfu-kfx.contract.json), [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md), [ADR-0007](../framework/core/docs/adr/ADR-0007-v4-tui-platform-reference-surface.md), [ADR-0011](../framework/core/docs/adr/ADR-0011-v4-capability-sdk-contract.md), [ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md), [ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md), [ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md), [`extensions.md`](extensions.md), [`kfx-topology.md`](kfx-topology.md) |
| `skill-contract` | Kungfu Skill source, catalog, context envelope, audit, and kfx dependency binding | integration | [`../framework/skill/kungfu-skill.contract.json`](../framework/skill/kungfu-skill.contract.json), [ADR-0015](../framework/core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md), [`skills.md`](skills.md), [`../framework/skill/README.md`](../framework/skill/README.md) |
| `config-contract` | Kungfu global config contract: schema, defaults, resolution rules, resolved output metadata, and packaged contract hash | integration + cross-time | [`config.md`](config.md), [`../framework/config/kungfu-config.contract.json`](../framework/config/kungfu-config.contract.json) |
| `kungfu-cli` | kungfu CLI surface (canonical `kungfu` command; commands, journal subcommand output conventions) | integration | [`debugging.md`](debugging.md) |
| `journal-replayability` | cross-version cold-path decode of recorded journals | cross-time | [ADR-0008](../framework/core/docs/adr/ADR-0008-yijinjing-schema-layout-baseline.md) |
| `v4-action-envelope` | Generic journal carrier for v4 runtime facts (`carrier_type=1000`, semantics in `action_type` / `schema_ref`) | integration + cross-time | [`carrier-type-registry.md`](../framework/core/docs/carrier-type-registry.md), [ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md), [ADR-0025](../framework/core/docs/adr/ADR-0025-carrier-type-and-action-envelope-semantics.md) |
| `rewind-event-schema` | Rewind capture payload schema (`rewind_events.fbs`) carried by action-envelope `rewind.*` action types; trace bundles bind and outlive runs | integration + cross-time | [`carrier-type-registry.md`](../framework/core/docs/carrier-type-registry.md), [`kungfu/rewind/README.md`](../framework/core/src/python/kungfu/rewind/README.md) |
| `shifu-launcher` (was `kungfu-code-launcher`) | Development/build entrypoint contract: `./shifu` task pass-through and rich subcommands, the native launcher's prebuilt release asset layout (`shifu-v<version>/shifu-<platform>`), and the `build-local.env` key set | integration | [`rust-adoption.md`](rust-adoption.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

A surface is registered when consumers bind to it at integration time without
runtime negotiation, or when its outputs remain depended on after the run.
Register changes are maintainer decisions and are logged below.

## Decision log

Line openings (minor/major), register changes, and deprecations are recorded
here, newest first. Patches are intentionally absent — silence means no
registered surface was touched.

| Date | Action | Line | Faces | Class | Rationale | PR |
|---|---|---|---|---|---|---|
| 2026-07-10 | rename | — | shifu-launcher (was kungfu-code-launcher) | additive | Rename the launcher product to `shifu` (entrypoints `./shifu` / `shifu.cmd`, crate `crates/shifu`, release tags `shifu-v<version>`, assets `shifu-<platform>`, env keys `SHIFU_*`); the tool's role — bootstrap the toolchain and walk you in — under a name that carries it. Same contract shape, pre-release, no external consumers; kungfu-code-v0.1.0 release retired and reissued as shifu-v0.1.0 | — |
| 2026-07-10 | register | — | kungfu-code-launcher | additive | Register the dev/build entrypoint as a welded surface: the shims and any CI bind at integration time to the task pass-through, the prebuilt asset layout under `kungfu-code-v<version>` tags (independent launcher version line starting 0.1.0, pinned by `crates/kungfu-code/Cargo.toml`), and the `build-local.env` keys. Existing entrypoint behavior is a compatible superset; monorepo product surfaces untouched. Pre-release, no line open | — |
| 2026-07-08 | update | — | v4-action-envelope, rewind-event-schema | behavioral | Rename journal header API from `msg_type` to `carrier_type`; migrate Atlas/Rewind/Work/KFX business semantics into `kungfu.action-envelope/v1` action types; raw 300xx/400xx business allocation is now gated out. Pre-release, no compatibility promise for pre-envelope Rewind/Work dogfood journals | — |
| 2026-07-08 | register | — | v4-action-envelope | behavioral | Reset v4 business carrier_type allocation: new runtime facts use `carrier_type=1000` as the action-envelope carrier and put business semantics in `action_type` / `schema_ref`; Atlas import migrates off 30201-30205. Pre-release, no compatibility promise for the pre-envelope Atlas journal profile | — |
| 2026-07-06 | update | — | config-contract, kfx-contract, skill-contract | additive | Add a shared KFD-1 contract registry/runtime: config, kfx, and skill contracts are registry-addressed, copied into frozen artifacts by one tool, verified by one artifact hash gate, and inspectable through `kungfu contract`. Pre-release, no line open | — |
| 2026-07-06 | update | — | kfx-contract | additive | Weld the KFX manifest/config mechanism to a single machine-readable contract: package manifest schema, first-party manifest schema, Python/Node validation, frozen artifact hash evidence, and CLI inspection. Pre-release, no line open | — |
| 2026-07-06 | register | — | config-contract | additive | Register the Kungfu config contract as a KFD-1 welded surface: one source for schema/defaults/resolution rules, with resolved output and frozen artifact hash evidence. Pre-release, no line open | — |
| 2026-07-05 | update | — | kungfu-cli | additive | Rename the terminal reference-surface command `kungfu tui` → `kungfu cockpit` (an operator surface: monitor + config + mission ops). The Ink renderer stays the `tui` substrate (`framework/tui`, `@kungfu-tech/tui`, `tui.mjs`, `Resources/tui`); only the command/experience name changes. Pre-release, no line open | — |
| 2026-07-05 | register | — | skill-contract | additive | Register Kungfu Skills as their own integration surface above kfx: `SKILL.md` source, compact catalog/context envelope, audit sidecars, Node/Python manager equivalence, and kfx dependency binding. Pre-release, no line open | — |
| 2026-07-05 | update | — | kfx-contract | additive | Extend the registered kfx contract references from GUI/TUI view loading to the current trust/load topology: source authority, runtime-plane sandbox/trusted channel, uniform capability surface, and proposed dual-host/service facet. Pre-release, no line open | — |
| 2026-07-05 | update | — | kungfu-cli | additive | Fold the application-assembly SDK into the CLI as the `kungfu sdk` subcommand (was the standalone `kfs` command); extension/example builds now run `kungfu sdk kfx build`. Pre-release, no line open; `kfs` was never a registered surface | — |
| 2026-07-04 | update | — | rewind-event-schema | additive | Append `ApprovalDecision`: human approve/deny/interrupt/resume decision recorded as a run fact, `SCHEMA_VERSION` 2→3. Later migrated under `rewind.approval.decision` action envelopes before v4 release |
| 2026-07-04 | update | — | rewind-event-schema | additive | Append `CostSnapshot`: normalized token/cost usage with attribution + confidence, `SCHEMA_VERSION` 1→2. Later migrated under `rewind.cost.snapshot` action envelopes before v4 release | — |
| 2026-07-02 | register | — | rewind-event-schema | additive | New face: Rewind capture payload schema with per-run `.bfbs` manifest bindings. The initial pre-envelope carrier-number encoding was later migrated to action envelopes before v4 release | — |
| 2026-07-02 | update | — | kungfu-cli (was kfc-cli) | additive | `kungfu` becomes the canonical CLI command, fronting the `kfc` runtime; `kfc` stays a working alias. Pre-release, no line open, nothing removed | #147 |
| 2026-07-08 | rename | — | yijinjing-schema-layout | breaking-pre-release | Retire the pre-v4 public schema package name and absorb the runtime fact schema into `kungfu/yijinjing/schema`. v1/v2/v3 layouts are not compatibility targets; v4 stable becomes the compatibility root | — |
| 2026-07-02 | register | — | yijinjing-schema-layout, capability-sdk-api, kfx-contract, kfc-cli, journal-replayability | additive | Initial register established on adopting KFD-1; schema layout was renamed and greenfielded before v4 stable release | — |
