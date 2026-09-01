# Native Agent adapters

Kungfu can launch a third-party terminal Agent without adding provider-specific
code to Kungfu. A `kungfu.native-provider-adapter/v1` declaration describes how
to find the executable, probe its version, advertise one Kungfu onboarding
Skill, and admit only named credential environment variables. An Agent Runtime
Profile then selects the exact executable and interactive arguments.

`versionArgv` must name a bounded non-interactive probe that exits. Its first
non-empty output line may be a semantic version or an opaque provider build
identity. The result is diagnostic metadata only: probe failure may produce a
warning, but never blocks an available executable from launching. Kungfu does
not require third-party version text to use `x.y.z`.

The adapter is intentionally not a shell hook. Kungfu launches an exact
executable-plus-argv vector with inherited stdin, stdout, and stderr. Template
expansion is limited to `{skill_file}`, `{skill_dir}`, `{skills_root}`,
`{adapter_root}`, and `{provider_log_dir}`; append `:json` when a path must be
JSON-quoted inside one argument. Generated files stay under Kungfu runtime
state. Kungfu does not edit the provider's home or capture terminal bytes.

Provider-owned diagnostic files under each native attempt are bounded before a
new attempt starts. Kungfu preserves every unfinalized attempt, then removes
files from finalized attempts when they are older than seven days or when the
finalized-log pool exceeds 256 MiB, oldest first. The materialized adapter
reports a `providerLogRetention` receipt with before/after bytes, removed file
count, and the number of unfinalized files protected. The built-in Codex adapter
also defaults `RUST_LOG` to `warn`; a caller may still override it explicitly.

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
variables. The separate `agent.nativeProcessEnvironment` array controls
registered ambient process capabilities. Its system default is
`["TMUX", "TMUX_PANE"]`, which lets a provider launched inside tmux retain the
exact current session and pane handles. Kungfu resolves those values only at
process launch; config, receipts, diagnostics, and durable state retain names,
never handle values. The two names form one capability and must be enabled as a
pair. Outside tmux, or when either value has an invalid shape, Kungfu passes
neither. Set the array to `[]` to disable this capability:

```sh
kungfu config set agent.nativeProcessEnvironment '[]' --json
```

This field is a closed registry, not a general environment allowlist:
unregistered names, wildcards, partial pairs, and `inheritAll` are rejected by
the config schema. Credential names remain governed separately by each
adapter's `credentialEnvironment`, and Kungfu still does not copy the rest of
the ambient shell environment.

`kungfu run <provider>` resolves its launch directory in this order:

1. an explicit `--workspace` or `KF_WORKSPACE_ROOT`;
2. a Project discovered from the current working directory;
3. the active `KUNGFU_WORKSPACE_ROOT`, when the command is launched from an
   existing Kungfu Agent session;
4. the Project selected by the machine-local Project registry; and
5. the current working directory without durable Work binding.

The final case is a supported provider launch, not an error. Kungfu tells the
user that no Project is bound and points to `kungfu project create-plan` and
`kungfu project select <path>`; the provider still opens in the requested
directory. A selected Project is reported before launch when it is used from a
different directory.

The built-in Codex adapter uses Codex's native inline TUI (`--no-alt-screen`).
This keeps the required first-use Project trust prompt and any startup error in
terminal scrollback. It also passes a unique `provider_log_dir` for each native
SessionAttempt, preventing a fresh Project trust launch from contending with an
ambient Codex log target while leaving the user's Codex home, login, config,
and trust state unchanged. Kungfu never answers that trust decision for the
user.

Before starting Codex, Kungfu names the directory whose trust prompt may
appear. The prompt reads and writes through the same provider PTY; users do not
need to start Codex separately. Kungfu also checks the Agent Session protocol
schema and all native lifecycle operations before it registers a
SessionAttempt. An older detached worker therefore fails before
`plan-native-start` with an actionable protocol-mismatch error. Close the
running Kungfu processes for that Project and retry; do not delete Project
data.

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

The human does not choose or calculate a Console name. A live Agent session may
serially observe any number of Work items; choosing another Work atomically
replaces only the session's current observation. It does not end or advance the
prior Assignment, and Assignment admission, review, closeout, and sealing never
depend on `WorkConsole` or `SessionAttempt` lifecycle.

The local Agent Session worker still coordinates one runtime-local writer per
exact Work. A simultaneous attempt to bind the same Work fails with
`native_work_already_active` and names the active provider, attempt, Console,
and recovery choices. Switching one session to another Work releases its prior
runtime-local guard, while the Work's authoritative state remains unchanged.
Exiting the provider also releases the guard; provider exit never claims Work
completion.

Custom adapter Skills may retain this pre-project-write observation boundary
for runtime-local coordination. Public `kungfu work claim` and kickoff paths
never bind an Agent Session automatically: they remain valid without a Console,
and their Work authority cannot be blocked by ambient provider state. A
third-party PTY Agent that wants observer projection must use the explicit
Agent-owned bind entrypoint separately.

## Compatibility boundary

This adapter covers PTY Agent CLIs whose onboarding can be expressed with exact
arguments, environment values, JSON-valued environment, or runtime-local JSON
files. Authentication and provider-owned configuration remain external. A CLI
that requires arbitrary shell evaluation or unbounded mutation of its home is
not admitted by this contract; it needs a reviewed adapter-contract extension,
not an escaped command string.
