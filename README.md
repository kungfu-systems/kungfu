# Kungfu

**Give your agent verified context. Keep the work when the chat ends.**

Stop re-explaining your project every time a chat resets. Kungfu helps an agent
understand the work from declared project sources, makes missing or conflicting
context visible, and preserves enough structure for a later agent session to
continue without reconstructing everything from conversation history.

> **Never Guess. Facts Unfold.**

**Status: Coming soon.** The first public CLI is being qualified against the
experience below.

## The first-release experience

The intended one-command path is:

```sh
cd your-project
kungfu run agent
```

The command is the target first-release entrypoint, not a claim that a public
artifact is available today. A qualified release must let the agent:

- inspect the project and explain what it understands;
- show important omissions, conflicts, and decisions instead of guessing;
- keep the current work coherent across fresh contexts and agent processes;
- record what happened so progress and the next action do not depend on chat
  history.

The first visible value should arrive within minutes. The deeper value appears
over the following days, when the same work survives context loss, changed
understanding, failed attempts, handoff, and restart.

## Why it matters

- **Less context pressure.** The agent can select verified project context
  instead of repeatedly loading the whole repository.
- **Durable work continuity.** Intent, current understanding, action boundaries,
  and outcomes remain available after the original conversation is gone.
- **Inspectable understanding.** Sources, omissions, uncertainty, and evidence
  stay visible to both people and agents.

## Keep using the agents you already have

`kungfu run agent` is the golden path, not a required replacement for Codex,
Claude Code, VS Code, terminals, or other agent surfaces. The same local
contracts and work state must remain available through the Kungfu CLI and APIs
when an agent continues to run elsewhere.

## Go deeper

- [How the complete Kungfu system works](docs/concepts/system-overview.md)
- [Documentation Guide](docs/README.md)
- [Documentation Map](docs/MAP.md)
- [Known Limits](docs/qualification/known-limits.md)
- [Build and contribute](CONTRIBUTING.md)

Agents working from a source checkout should begin with [AGENTS.md](AGENTS.md)
and [Verified Context for Agents](docs/guides/xinfa-agent-context.md). An
installed runtime carries its own local agent brief:

```sh
kungfu agent brief
```

## Build from source

Public release artifacts are not available yet. To evaluate the current source
tree:

```sh
git clone https://github.com/kungfu-systems/kungfu.git
cd kungfu
./shifu doctor
./shifu sync && ./shifu build
```

## Project status

Kungfu v4 is **Coming soon**. Source-built capabilities and qualification
slices exist, but public packaging, cross-platform evidence, strong power-loss
durability, and the institutional profile remain staged unless linked evidence
says otherwise.

Design intent, implemented behavior, qualified guarantees, and released
artifacts are deliberately distinct. Before relying on a claim, check
[Contracts](docs/qualification/contracts.md),
[Known Limits](docs/qualification/known-limits.md), and the applicable retained
qualification evidence.

<!-- buildchain:badges:start -->
[![KFD-1: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-1/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![KFD-2: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-2/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![KFD-3: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-3/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![KFD-4: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-4/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![Buildchain Release Passport: declared](https://buildchain.libkungfu.dev/badges/v1/buildchain-release-passport/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0969da.svg)](https://github.com/kungfu-systems/kungfu/blob/HEAD/LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6e7781.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![Source Acceptance](https://github.com/kungfu-systems/kungfu/actions/workflows/source-acceptance.yml/badge.svg)](https://github.com/kungfu-systems/kungfu/actions/workflows/source-acceptance.yml)
[![Buildchain Validate](https://github.com/kungfu-systems/kungfu/actions/workflows/buildchain-validate.yml/badge.svg)](https://github.com/kungfu-systems/kungfu/actions/workflows/buildchain-validate.yml)
[![DCO](https://github.com/kungfu-systems/kungfu/actions/workflows/dco.yml/badge.svg)](https://github.com/kungfu-systems/kungfu/actions/workflows/dco.yml)
<!-- buildchain:badges:end -->

## Project links

- Product home: <https://kungfu.tech>
- Developer and agent surface: <https://libkungfu.dev>
- Issues and questions: [GitHub issue forms](https://github.com/kungfu-systems/kungfu/issues/new/choose)
- Security reports: [SECURITY.md](SECURITY.md)
- License: [Apache License 2.0](LICENSE)
