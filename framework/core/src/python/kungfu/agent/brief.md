# Kungfu Agent Onboarding Pack

This installed runtime carries a local agent pack. Use it before guessing from
old docs, release notes, or memory.

Start here. This one command is the complete onboarding read; the remaining
commands deepen the facts when the task needs them:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent work-model --json
kungfu agent choose-mode --json
kungfu agent verify --json
kungfu agent status --target codex --json
kungfu agent console current --json
kungfu agent runtime list --json
kungfu agent session capabilities --json
kungfu agent session list --json
kungfu cut --repo <path> --json
kungfu work capabilities --json
kungfu work export <work-id> --repo <path> --json
kungfu work import --file <envelope.json> --repo <path> --json
```

Kungfu has one public executable. Xinfa and all four Action Primitive roles are
subcommands of it:

```text
kungfu xinfa compile        workspace -> immutable Xinfa Atlas
kungfu atlas ...            perspective and Fact Cut
kungfu pursuit ...          intent continuity
kungfu warrant ...          bounded authority
kungfu episode ...          causal experience
```

Use `capabilities`, `inspect`, and `action` under each role group. Role actions
delegate to one Profile engine and native Fact authority; they do not prove
Pursuit completion. Xinfa retains its own schemas, `.xinfa` state, version, and
engine qualification, but the installed engine is private and is not a second
PATH command.

Before source implementation, load the repository's verified Xinfa context
instead of treating this brief, a README, or chat history as the whole task
surface. `xinfa-context.md` in this pack gives the stable boundary. In a Kungfu
checkout, start with:

```sh
./shifu docs inventory --json
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
```

Choose the route from the inventory. Ambiguous or degraded resolution, failed
Atlas verification, stale authority, and required omissions fail closed. An
installed runtime can verify its precompiled documentation Atlas and compile a
workspace Atlas through the same public entrypoint:

```sh
kungfu agent docs --verify --json
kungfu agent docs --projection agent --json
kungfu xinfa compile
kungfu xinfa compile --workspace <repo> --output <atlas-dir> --json
```

Automatic admission requires a coordinator that invokes and binds Xinfa's
task-envelope, route-resolution, and Task Chart contracts. A Go card, Skill,
instruction file, or Episode alone does not execute the compiler.

Kungfu is journal-first infrastructure for capturing local facts, replaying
runs, and making control decisions from evidence. The agent-facing layer is not
ambient permission. It is a set of local facts, command contracts, Skill
instructions, and kfx trust boundaries that must remain inspectable after
installation.

The KFD-3 collaboration interface is declared in `kfd3_api.registry.json`.
`commands.json`, this brief, and provider skills are projections of that
registry. `kungfu agent verify --json` checks the installed runtime command tree
against the registry so a shipped agent surface cannot quietly expose extra
`kungfu agent` commands outside the declared interface.

Project-level work starts from the current Cut. `kungfu cut --repo <path>
--json` is read-only, and `kungfu work capabilities --json` reports every
high-level operation with its current availability and authority boundary.
The same manifest appears as `workLoop` in `kungfu agent capabilities --json`;
an unavailable or plan-only operation must not be inferred to be executable.
Portable Work export excludes machine-local timestamps and binds the envelope
to the verified current Project Cut. Import is read-only unless `--execute` is
present. Its portable root proves integrity, not origin authenticity; execution
is the explicit local admission decision.

For portable Exit packages, use
`kungfu-exit-verify --file <package.json> --json` (or
`python -m kungfu.exit_verifier`) when no Kungfu runtime or source checkout is
available. The integrated `kungfu exit verify` alias is for an already
configured runtime; verifier success is read-only evidence, not import
authorization. Before claiming version compatibility, run
`kungfu exit verify --info --json` and inspect the shipped product version,
contract roots, protocol inventory, support policy, exact qualification
boundary, and non-claims. Product SemVer alone is not compatibility proof.

Long-running real-world work uses four independently inspectable roles:
Pursuit for intent continuity, Atlas for the declared perspective and fact cut,
Warrant for bounded authority, and Episode for causal experience. Read the
installed source contract with `kungfu agent work-model --json`. Mission/Go is
one Profile projection of this model, not universal Core vocabulary, and the
contract reports P17 qualification debt instead of manufacturing missing proof.

At the lower runtime layer, Fact and Episode are parallel substrates: Fact
states what is admitted at an explicit Cut; Episode preserves bounded causal
experience across Cuts. Pursuit, Atlas, and Warrant use Fact identity, versions,
relations, and projections. Episode remains independently identified and does
not become a state diff. Journal authority establishes semantic visibility;
content-addressed bodies without a journal reference are only material.

Fact Root identity is versioned. Existing
`sha256-length-framed-fields-v1` roots remain exact legacy identities and must
never be normalized or relabeled. New portable implementations target
`kungfu.fact-root.canonical/v2` (KFR2), whose typed bytes, stable rejection
codes, independent implementations, and conformance corpus are reported by
`kungfu contract show fact-cut-kernel --json`. KFR2 is the explicit default
writer for new records. The v1 reader remains required, and every successor
record exposes an explicit mapping receipt without rewriting old history;
downgrade writes fail closed.

Inside the native Agent Console, `kungfu agent console current --json` validates
the content-bound Console/attempt envelope. Preserve its WorkRef and exact
Profile roots, then query its context/capability/Profile entrypoints. The
Console is execution placement, not silent authority over an external source;
its transcript is not completion proof.

Agent Console presentation and KFD-3 use one Agent Session action surface.
Discover it with `kungfu agent session capabilities --json`, then use
`plan-start`/`start` or `plan-control`/the matching action against the returned
exact root. These actions control Capsule delivery only. Work mutation and
completion proof still belong to public Profile/KFD-3 actions and receipts.

Use the modes this way:

- **brief**: read the local facts; no runtime action.
- **report**: create or inspect structured work facts with `kungfu work`, and
  append external run facts with `kungfu report`. Native Codex goals should use
  `kungfu codex report-goal` and verify the receipt before closeout.
- **domain-facts**: when a user has explicitly declared a contract world and
  schema-owned fact surface, use the experimental `kungfu facts` commands to
  record observations, inspect admission outcomes, and replay a historical
  system-time cut. Recording is not admission or external truth.
- **atlas-projection**: snapshot an Atlas-style control-plane repo with
  `kungfu atlas import` when the user asks to sync, inspect, or visualize
  missions, goals, and worktree markers in Kungfu.
- **trace**: capture an existing command with `kungfu trace -- <command>`.
- **managed-run**: let Kungfu launch a provider CLI with skill context and run
  evidence; this surface is experimental. Keep the report closeout gate as a
  fallback when switching between managed-run and report mode.
- **remote-sync**: mirror evidence across runtime boundaries with source labels;
  `kungfu remote` is experimental and does not merge remote facts into local
  authoritative truth.

Workspace targeting is command-sensitive. Independent agent commands never
inherit Desktop recents. Inspect first; only capture-only managed runs and
Episode imports may use Home automatically when no project is discovered:

```sh
kungfu workspace inspect --home --json
kungfu managed-run --provider <provider> --prompt <task>
kungfu storage import --from <episode-bundle.json> --execute --json
```

A project that opens from qualified settled shadows can request the missing
full Episode evidence without creating runtime state, then validate before an
explicit import. The bundle must resolve to an Episode root already present in
the settled shadow:

```sh
kungfu workspace request-full-evidence <path> --json
kungfu workspace import-full-evidence <path> --from <episode-bundle.json> --json
kungfu workspace import-full-evidence <path> --from <episode-bundle.json> --execute --json
```

Project-workspace guidance follows one bounded protocol. Preserve the returned
identities exactly; authorization for workspace creation never authorizes Git
mutation, attachment, source-authority changes, or publication:

```sh
kungfu workspace advise --home --source <path> --json
kungfu workspace preview --home --source <path> --intent create-project-workspace --json
kungfu workspace authorize --home --source <path> --intent create-project-workspace --preview-id <id> --decision approve --authorized-by <actor> --json
kungfu workspace apply --home --source <path> --authorization-id <id> --json
kungfu workspace verify --home --receipt-id <id> --json
```

If relevant capture facts change after authorization, `apply` rejects the
stale preview. Recompute advice and preview instead of widening the old grant.
In an existing Git repository, `prepare-portable-contract` may create only the
low-frequency `.kungfu/contract/workspace.json` input. It still does not grant
Git init, ignore edits, stage, commit, push, remote creation, or publication;
high-frequency runtime, journal, storage, inbox, and payload paths stay excluded.

When the user asks to sync an Atlas-style control-plane repo into Kungfu,
snapshot it and verify the projection with:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage fsck --scope all --json
kungfu storage repair --scope episode --episode-id <id> --plan --dry-run --json
kungfu storage repair --scope episode --episode-id <id> --fetch --out repair-material.json --dry-run --json
kungfu storage repair --scope episode --episode-id <id> --apply --from <bundle.json> --dry-run --json
kungfu storage verify-sync --source <source-id> --json
kungfu atlas show import --json
kungfu atlas show missions --json
kungfu atlas show goals --json
kungfu atlas show markers --json
```

The source repo remains the authority. Kungfu stores a read-only projection for
inspection in CLI, GUI, and kfx work views.

Runtime activation is capability-driven rather than PID-driven. Inspect the
contract and plan before assuming a resident process is needed:

```sh
kungfu runtime operations --json
kungfu runtime plan episode.inspect --json
kungfu runtime status --json
```

Storage-only operations remain daemonless. Live-required operations fail closed
unless the Core broker returns matching capabilities and native readiness at
the requested durable cut. `runtime ensure` and process status are advanced
operator diagnostics; process liveness, GUI visibility, and readiness
descriptor bytes are not semantic readiness. The descriptor carries only
workspace-bound native authority coordinates and is revalidated when consumed.
The shipped process host is qualified in a named platform envelope; Kungfu does
not claim a production `EmbeddedRuntimeHost`, cross-machine lease/election, HA,
or universal activation SLO.

The pack is included by the Electron artifact, the standalone CLI, npm
`@kungfu-tech/core`, and the PyPI wheel. Future Homebrew, winget, container, and
kfx packaging must keep the same pack validation gate before claiming support.

Profile authoring is also agent-first. Discover the installed contract before
generating source; scaffold is plan-only unless `--execute` is explicit, and
identity, authority, evidence, migration, and permission choices are never
self-certified by generated files:

```sh
kungfu profile capabilities --json
kungfu profile examples --json
kungfu profile scaffold brief.json --out ./my-profile --json
kungfu profile validate ./my-profile --json
kungfu profile collaboration ./my-profile --json
kungfu profile application ./my-profile --json
kungfu profile intent inspect ./my-profile <intent-id> --json
kungfu profile intent advise ./my-profile <intent-id> --json
kungfu profile intent plan ./my-profile <intent-id> --json
kungfu profile intent authorize ./my-profile <intent-id> --expected-plan-id <id> --choice approve --authorized-by <actor> --json
kungfu profile intent apply plan.json --authorization-file answer.json --json
kungfu profile intent verify ./my-profile receipt.json --json
kungfu profile kfd3-status ./my-profile --json
kungfu profile kfd3-plan ./my-profile --json
kungfu profile kfd3-authorize ./my-profile --expected-plan-id <id> --choice approve --authorized-by <actor> --json
kungfu profile kfd3-verify ./my-profile receipt.json --json
kungfu profile qualify ./my-profile --json
kungfu profile plan install ./my-profile --json
kungfu profile manager --json
kungfu profile catalog ./my-profile --require-active --json
kungfu profile query-plan ./my-profile <view-id> --json
kungfu profile query-execute ./my-profile --plan-base64 <base64-json> --json
kungfu profile assessment-plan ./my-profile --query-receipt-base64 <base64-json> --claim-id <id> --policy-id <id> --purpose <purpose> --work-episode-id <id> --json
kungfu profile assessment-authorize --plan-base64 <base64-json> --choice approve --authorized-by <actor> --json
kungfu profile member-call ./my-profile <member-id> <read-operation> --input-base64 <base64-json> --json
```

The Profile layer computes member roots from package bytes and delegates all
lifecycle state to Core. Decision cards are open questions, not authorization;
after an answer, produce a fresh plan and apply it with the resulting external
authorization identity. Optional code members build with
`kungfu sdk kfx build` and do not require rebuilding Kungfu.
When a brief includes `collaboration`, scaffold emits a content-bound generic
Human/Agent declaration with explicit participants, value, constraints, and
known limits. `profile collaboration` audits action/view/authority/capability
closure and reports `declared-closed`, but it remains `qualified: false` until
Kungfu has produced the runtime probes and KFD-3 witness; schema validity,
KFD-1/KFD-2 qualification, and KFD-3 qualification are separate states. The
`kfd3-status` never runs probes: it returns the shared machine state, issuer,
receipt coordinates, and next actions used by the GUI badge. `kfd3-plan`
previews the exact probe set, and `kfd3-authorize` earns and journals a
deterministic receipt only for an exact active root after installed
Agent-interface closure, custom-view no-bypass, and Human/Agent exact-plan
probes pass. A Profile cannot supply that receipt or witness in its own source
tree.
The generic Profile Manager calls these same installed application commands.
Its intent card is a visual projection of the same Profile/collaboration roots,
decision card, action receipt, and verification result; GUI focus or custom
presentation never grants a separate mutation path. Verification proves the
declared cut and execution receipt, not that a domain claim is true in reality.
The Profile Manager GUI reads the same manager projection and previews the same
decision card. Its apply path re-plans against the reviewed plan id; GUI focus
does not activate a Profile and removing a Profile does not delete facts.

Bootstrap surfaces are local and explicit:

```sh
kungfu agent bootstrap --target codex --mode report
kungfu agent mode set --target codex --mode managed-run
kungfu agent unbootstrap --target codex
kungfu agent uninstall --target codex
```

These commands dry-run by default unless they expose an `--execute` flag. They
do not read provider credentials and do not delete receipts, work items, or
Rewind bundles.
