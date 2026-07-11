# Kungfu Config

Kungfu separates local state into workspace data, user config, and machine data
fallback. The architecture decision is
[ADR-0035](../framework/core/docs/adr/ADR-0035-workspace-local-kungfu-data-home.md).

- Workspace `.kungfu/` is the default fact-ledger home when a workspace boundary
  exists. It stores Episodes, the Episode manifest journal, payload bodies,
  projections, source registry, and workspace-local runtime facts.
- `KF_CONFIG_HOME` is the agent-facing global configuration home. Its default is
  `~/.kungfu-config`; the first user override file is
  `~/.kungfu-config/config.json`.
- `KF_HOME` remains the explicit or machine-level runtime data fallback when no
  workspace `.kungfu/` applies. It stores machine-level runtime state, global
  catalog/cache/service state, and non-workspace facts.

The matching live process topology is
[ADR-0036](../framework/core/docs/adr/ADR-0036-supervisor-and-workspace-master-topology.md):
a per-user `supervisor` is a router/process manager, while each resolved
workspace or fallback data root can have its own `master`. The supervisor may
keep small routing/runtime state under the user config area; workspace master
process-control state belongs under the resolved data root.

The split is intentional. Runtime data can be large and stateful; workspace
facts should live near the project they describe; global config is small,
agent-maintained, and safe to inspect without reading journals or provider
credentials.

## Contract, defaults, and overrides

Kungfu config is a KFD-1 registered welded surface, `config-contract`. The
single source is:

```text
framework/config/kungfu-config.contract.json
```

That contract contains:

- the JSON Schema for the config contract itself;
- the JSON Schema for valid config;
- the default config values;
- resolution rules such as `KF_CONFIG_HOME`, `KF_HOME`, `config.json`,
  placeholder expansion, workspace data home discovery, and merge behavior.

Python, Node, and the frozen product load the same contract. The frozen product
ships it at:

```text
dist/kungfu/config/kungfu-config.contract.json
```

`shifu verify` checks that the frozen artifact contract hash matches the
repo contract hash, then runs the frozen `kungfu config show --json` and checks
that the runtime-reported contract hash is the same. Defaults, resolution rules,
and schema must not be redefined in Python, Node, GUI, or other feature
modules.

A user config file is optional. If `~/.kungfu-config/config.json` does not exist,
config resolution still succeeds and no file is created as a side effect.

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

Object values merge recursively. Array and scalar values replace the default.
This keeps the user file small while preserving a complete resolved view for
agents and GUI code.

User overrides are validated as partial config. The final resolved config is
validated as a complete config against the same contract schema.

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
kungfu config set ui.fontSize 16 --json
kungfu config set ui.scale 1.1 --json
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
a compact `kungfu.config.path/v1` payload. The `contract.hash` field makes the
exact contract world inspectable by users, agents, and release gates.

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
