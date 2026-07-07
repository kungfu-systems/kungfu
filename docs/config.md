# Kungfu Config

Kungfu has two separate local homes:

- `KF_HOME` is the runtime data home. It stores journals, runtime databases,
  archives, datasets, and other state produced by Kungfu itself. Its default is
  platform-native: `~/Library/Application Support/kungfu/home` on macOS,
  `${XDG_CONFIG_HOME:-~/.config}/kungfu/home` on Linux, and
  `%APPDATA%/kungfu/home` on Windows.
- `KF_CONFIG_HOME` is the agent-facing global configuration home. Its default is
  `~/.kungfu`. The first user override file is
  `~/.kungfu/config.json`.

The split is intentional. Runtime data can be large and stateful; global config
is small, agent-maintained, and safe to inspect without reading journals or
provider credentials.

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
  placeholder expansion, and merge behavior.

Python, Node, and the frozen product load the same contract. The frozen product
ships it at:

```text
dist/kungfu/config/kungfu-config.contract.json
```

`kungfu-code verify` checks that the frozen artifact contract hash matches the
repo contract hash, then runs the frozen `kungfu config show --json` and checks
that the runtime-reported contract hash is the same. Defaults, resolution rules,
and schema must not be redefined in Python, Node, GUI, or other feature
modules.

A user config file is optional. If `~/.kungfu/config.json` does not exist,
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

- paths: config home, runtime home, skill roots, and kfx roots;
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
```

`kungfu config contract --json` returns the full
`kungfu.config.contract/v1` contract, including its own `contractSchema`.
`kungfu config schema --json` returns the config schema from that contract.

`kungfu config show --json` returns `kungfu.config.resolved/v1`: built-in
defaults, optional user overrides, contract metadata, source metadata,
`configHome`, `configPath`, and `runtimeHome`. The `contract.hash` field makes
the exact contract world inspectable by users, agents, and release gates.

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
`kungfu kfx list --json` for on-demand discovery.
