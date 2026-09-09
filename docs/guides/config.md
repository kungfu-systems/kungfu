# Kungfu Config

Kungfu separates local state into workspace data, user config, and machine data
fallback. The architecture decision is
[KF-ADR-019f86da-4f90-7e58-bb03-bee0f101dc01](../adr/KF-ADR-019f86da-4f90-7e58-bb03-bee0f101dc01.md); the complete
path and persistence contract is
[KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76](../adr/KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76.md).
For the boundary between this workspace layout and the still pre-normative
portable semantic format, see the
[`.kungfu` Format Contract](../architecture/kungfu-format-contract.md).

- Workspace `.kungfu/` is the default fact-ledger home when a workspace boundary
  exists. It stores Episodes, the Episode manifest journal, payload bodies,
  projections, source registry, and workspace-local runtime facts.
- `KF_CONFIG_HOME` is the agent-facing global configuration home. Its default is
  `~/.kungfu-config`; the first user override file is
  `~/.kungfu-config/config.json`.
- A workspace can override that user policy at `.kungfu/config.json`. This file
  contains configuration only; the surrounding `.kungfu/` remains the
  workspace fact-ledger home.
- `KF_HOME` remains the explicit or machine-level runtime data fallback when no
  workspace `.kungfu/` applies. It stores machine-level runtime state, global
  catalog/cache/service state, and non-workspace facts.

`kungfu storage layout --json` reports the additive
`kungfu.workspace.episode-layout/v1` contract. Every entry is classified as
`durable`, `ephemeral`, or `cache`; use
`kungfu storage layout --verify --json` to fail when the home contains an
unclassified durable candidate. Layout v1 is additive-only: renaming, removing,
or changing the meaning or persistence class of an existing path requires v2
and a migration path. The journal wire epoch pinned by this layout is
`0xe3b24c8d` (`3820113037`). KFX authorization is not part of this
workspace-layout contract; it is derived from exact Core-owned Fact/Work roots
at runtime.

`.xinfa/` is not another runtime home. It is the Git-published Xinfa semantic
input surface. Live journals, locks, payload bodies, private/raw material,
projections, and caches stay in ignored `.kungfu/` runtime storage; Xinfa
project declarations, recipes, promoted manifests, and reviewed submissions
stay in `.xinfa/`.

The matching live process topology is
[KF-ADR-019f86da-4f90-730a-a068-06e8758324e1](../adr/KF-ADR-019f86da-4f90-730a-a068-06e8758324e1.md):
a per-user `supervisor` is a router/process manager, while each resolved
workspace or fallback data root can have its own `coordinator`. The supervisor may
keep small routing/runtime state under the user config area; workspace coordinator
process-control state belongs under the resolved data root.

The split is intentional. Runtime data can be large and stateful; workspace
facts should live near the project they describe; global config is small,
agent-maintained, and safe to inspect without reading journals or provider
credentials.

## Contract, defaults, and overrides

Kungfu config is a KFD-1 registered welded surface, `config-contract`. The
single source is:

```text
framework/core/config/kungfu-config.contract.json
```

That contract contains:

- the JSON Schema for the config contract itself;
- the JSON Schema for valid config;
- the default config values;
- resolution rules such as `KF_CONFIG_HOME`, `KF_HOME`, `config.json`,
  placeholder expansion, workspace data home discovery, user/workspace
  precedence, and merge behavior.

Python, Node, and the assembled product load the same contract. The product
ships it at:

```text
dist/kungfu/config/kungfu-config.contract.json
```

`shifu verify` checks that the assembled artifact contract hash matches the
repo contract hash, then runs the assembled `kungfu config show --json` and checks
that the runtime-reported contract hash is the same. Defaults, resolution rules,
and schema must not be redefined in Python, Node, GUI, or other feature
modules.

User and workspace config files are optional. If neither exists, config
resolution succeeds from defaults and creates no file as a side effect.

The user file is a JSON object that overrides only the keys it needs:

```json
{
  "schema": "kungfu.config.override/v1",
  "ui": {
    "fontSize": 18,
    "scale": 1.25
  },
  "shortcuts": {
    "commandPalette": "Ctrl+K"
  }
}
```

Resolution is defaults, then user, then workspace. Object values merge
recursively. Array and scalar values replace the lower-precedence value. This
keeps override files small while preserving a complete resolved view for agents
and GUI code.

User overrides are validated as partial config. The final resolved config is
validated as a complete config against the same contract schema.

Durability is the first policy with a complete native execution chain. Its
requested policy, admission result, effects, costs, receipts, timeout handling,
and rollback are documented in [Configure durability](durability-configuration.md).
Third-party PTY Agent declarations and their bounded Skill injection contract
are documented in [Native Agent adapters](native-agent-adapters.md).

## First default surface

The first config slice includes:

- paths: workspace data home, machine data home, config home, skill roots, and
  kfx roots;
- agent entrypoint: `kungfu agent context --json`;
- managed-run behavior flags;
- GUI font family, font size, and whole-UI scale;
- common shortcuts such as command palette, quick open, zoom, agent panel, and
  skill manager.

These defaults are not a complete preference system. They are the smallest
agent-first baseline needed for installed Kungfu to be self-describing and
adjustable.

## CLI

Agents should prefer machine-readable output:

```sh
kungfu config path --json
kungfu config contract --json
kungfu config schema --json
kungfu config defaults --json
kungfu config show --json
kungfu config durability --json
kungfu config set ui.fontSize 16 --scope user --json
kungfu config set ui.scale 1.1 --json
kungfu config set storage.durability.defaultProfile durable_group --scope workspace --json
kungfu config unset ui.scale --json
kungfu agent context --json
kungfu agent verify --json
```

`kungfu config contract --json` returns the full
`kungfu.config.contract/v1` contract, including its own `contractSchema`.
`kungfu config schema --json` returns the config schema from that contract.

`kungfu config show --json` returns `kungfu.config.resolved/v1`: built-in
defaults, optional user overrides, contract metadata, source metadata,
`configHome`, `configPath`, `runtimeHome`, `workspaceDataHome`, and
`machineDataHome`. `kungfu config path --json` returns the same path decision in
a compact `kungfu.config.path/v1` payload, including `workspaceConfigPath` when
a workspace is active. The `contract.hash` field makes the
exact contract world inspectable by users, agents, and release gates.
`digests.storageDurability` identifies the canonical requested durability
policy. `kungfu config durability --json` then separates requested, admission,
effective, and native-capability state; editing configuration cannot create
qualification.

Use `kungfu storage layout --json` when the question is not "which config wins"
but "where do workspace Episode journals, payloads, provider state, and
projections live under the resolved data home". That layout is reported by the
C++ storage service and keeps `KF_CONFIG_HOME` separate from workspace data.

`Fact Manager` and `kungfu facts type|material|export|import` use this same
resolved data root. Personal and workspace libraries therefore have identical
on-disk semantics: the difference is only which root was selected. Workspaces
pin exact fact-type versions into their own `.kungfu/`; they never follow a
mutable type from another root implicitly. Full bundles are the transfer path
when schema/payload closure must travel; thin bundles are explicit references,
not backups.

## Isolated product instances

Use an instance home when you need to run a second local Kungfu app without
sharing the default homes:

```sh
./shifu product gui dev --instance-home ~/kungfu-instances/demo
```

`--instance-home <path>` also accepts `--home <path>` and `-H <path>`. The
argument is an instance root; the product launcher keeps config and runtime home
separate under that root:

```text
KF_CONFIG_HOME=<path>/config
KF_HOME=<path>/home
KF_RUNTIME_DIR=<path>/home/runtime
```

For the GUI, Electron `userData` also moves under `<path>/userData`, so caches
and app-window state do not collide with the default instance. The same option
works with `product tui ...` commands.

When `product gui dev` or `product tui dev` runs from a workspace and no
explicit home environment or option is already set, the accepted target is to
prefer the workspace `.kungfu/` data home. If a Git root exists, the default
workspace home is `<git-root>/.kungfu/`; otherwise an existing ancestor
`.kungfu/` wins before falling back to machine-level `KF_HOME`. Use
`--no-instance-home` to disable dev-launch instance selection where supported.

On the first real launch for an instance root, if
`<path>/config/config.json` does not exist and the machine default
`~/.kungfu-config/config.json` exists, the launcher can copy that default config
file into the instance config home. Later launches never overwrite the instance
copy, so tests can change config without changing the machine default.

`kungfu config set <dotted-key> <json-value>` writes a user override to
`configPath`, validates it against the same contract, and returns the resolved
config with `--json`. Plain values that are not JSON decode as strings, so
`kungfu config set ui.fontFamily system` and
`kungfu config set ui.fontFamily '"SF Pro Text, system-ui, sans-serif"'` are
both valid.

`kungfu agent context --json` is the canonical local discovery entrypoint for
agents. Managed-run envelopes point to this command instead of carrying config,
command lists, document lists, skill roots, or kfx roots in every prompt.
The agent context can then return lightweight interface pointers such as
`kungfu skill list --json`, `kungfu skill catalog --json`, and
`kungfu kfx list --json` for on-demand discovery. The KFD-3 collaboration
interface itself is declared in the installed agent pack registry; use
`kungfu agent verify --json` to check that the packaged command catalog and the
runtime `kungfu agent` command tree stay aligned with that registry.
