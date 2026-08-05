# Native Agent adapters

Kungfu can launch a third-party terminal Agent without adding provider-specific
code to Kungfu. A `kungfu.native-provider-adapter/v1` declaration describes how
to find the executable, probe its version, advertise one Kungfu onboarding
Skill, and admit only named credential environment variables. An Agent Runtime
Profile then selects the exact executable and interactive arguments.

`versionArgv` must name a bounded non-interactive probe that exits. Its first
non-empty output line may be a semantic version or an opaque provider build
identity; Kungfu does not require third-party version text to use `x.y.z`.

The adapter is intentionally not a shell hook. Kungfu launches an exact
executable-plus-argv vector with inherited stdin, stdout, and stderr. Template
expansion is limited to `{skill_file}`, `{skill_dir}`, `{skills_root}`,
`{adapter_root}`, and `{provider_log_dir}`; append `:json` when a path must be
JSON-quoted inside one argument. Generated files stay under Kungfu runtime
state. Kungfu does not edit the provider's home or capture terminal bytes.

## Register an adapter

The example below uses a fictional `termagent` CLI:

```json
[
  {
    "schema": "kungfu.native-provider-adapter/v1",
    "id": "termagent",
    "label": "Terminal Agent",
    "discovery": {
      "executableNames": ["termagent"],
      "knownPaths": [],
      "versionArgv": ["--version"]
    },
    "credentialEnvironment": ["TERMAGENT_API_KEY"],
    "skill": {
      "source": "/absolute/path/to/termagent-kungfu/SKILL.md",
      "argv": ["--instructions", "{skill_file}"],
      "environment": {},
      "environmentJson": {},
      "files": []
    },
    "knownLimits": []
  }
]
```

Store that array in the user config and inspect discovery:

```sh
kungfu config set agent.nativeProviderAdapters '<adapter-array-json>' --json
kungfu agent runtime discover --json
```

`agent.nativeProviderAdapters` is an array-replacement config field. Preserve
any existing entries when adding another adapter. A configured adapter cannot
replace the built-in `codex`, `claude`, `amp`, or `opencode` adapter.

## Create and run a profile

```sh
kungfu agent runtime upsert \
  --id termagent.path.local \
  --label 'Terminal Agent local CLI' \
  --provider termagent \
  --executable termagent \
  --backend direct \
  --json

# Review the preview, then repeat with --execute.
kungfu agent runtime upsert \
  --id termagent.path.local \
  --label 'Terminal Agent local CLI' \
  --provider termagent \
  --executable termagent \
  --backend direct \
  --execute --json

kungfu agent runtime verify termagent.path.local --json
kungfu run agent --agent termagent.path.local
```

The provider UI remains native. Every bare launch creates a fresh,
automatically named workspace Console and SessionAttempt, so several terminal
windows may run Agents concurrently in one Project. Launching does not guess or
claim Work, even if only one Assignment currently exists.

Kungfu preserves a valid terminal type. If all three standard streams are
attached to a real terminal but the launcher supplied an empty or `dumb`
`TERM`, Kungfu uses the conservative `xterm` baseline for the provider process.
It does not apply that recovery to piped or headless execution. A nonzero
provider exit always leaves an actionable Kungfu error in the terminal and
ends only the SessionAttempt; it does not claim Work completion.

Native launch also preserves bounded, non-secret terminal capability metadata
such as `TERM_PROGRAM`, `TERMINFO_DIRS`, `LC_TERMINAL`, and common color-mode
variables. Session and pane control handles remain excluded. This lets a
provider select the correct input protocol for the inherited PTY without
receiving the rest of the ambient shell environment.

The built-in Codex adapter uses Codex's native inline TUI (`--no-alt-screen`).
This keeps the required first-use Project trust prompt and any startup error in
terminal scrollback. It also passes a unique `provider_log_dir` for each native
SessionAttempt, preventing a fresh Project trust launch from contending with an
ambient Codex log target while leaving the user's Codex home, login, config,
and trust state unchanged. Kungfu never answers that trust decision for the
user.

Once the Agent chooses an Assignment, its onboarding Skill runs the binding
boundary through the exact front door injected by the launch before edits or
Work mutation:

```sh
"$KUNGFU_CLI_BIN" agent console bind-work \
  --initiative-id <initiative-id> \
  --assignment-id <assignment-id> \
  --json
```

`KUNGFU_AGENT_CONTEXT.entrypoints.bindWork` carries the same executable and
argv as structured data. `plan-native-bind-work` and `bind-native-work` are
internal Agent Session protocol operations advertised for product adapters;
they are not canonical CLI entrypoints and Agents must not invoke them through
`kungfu agent session`.

The human does not choose or calculate a Console name. The local Agent Session
worker atomically gives one live attempt the Work binding. A simultaneous
attempt to bind the same Work fails with `native_work_already_active` and names
the active provider, attempt, Console, and recovery choices. Different Work
bindings remain concurrent. Exiting the owning provider releases the live
single-writer guard; provider exit still does not claim Work completion.

Custom adapter Skills must retain this same pre-write binding boundary. Public
`kungfu work claim` and kickoff paths also bind automatically when invoked from
inside a native Console, so a compatible third-party PTY Agent cannot create a
second authoritative Work lease through those commands.

## Compatibility boundary

This adapter covers PTY Agent CLIs whose onboarding can be expressed with exact
arguments, environment values, JSON-valued environment, or runtime-local JSON
files. Authentication and provider-owned configuration remain external. A CLI
that requires arbitrary shell evaluation or unbounded mutation of its home is
not admitted by this contract; it needs a reviewed adapter-contract extension,
not an escaped command string.
