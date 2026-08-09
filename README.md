# Kungfu

**Your agents don't hand off the work. You do.**

Every switch means copying context, re-explaining decisions, chasing updates,
and checking what got lost. Kungfu keeps the same work moving, no matter which
agent takes over.

Use the best Agent when it matters. Use a cheaper one when it does not. Keep the
same Work across Codex, Claude, OpenCode, Amp, or your own execution surface.

## Start where you already work

Once the `kungfu` command is on your
[`PATH`](docs/guides/installing-cli.md#make-kungfu-available-in-path), choose the
entry that matches how you already work.

**Stay in your current Agent.** Paste this sentence into Codex, Claude, OpenCode,
Amp, or another Agent that can run local commands:

```text
Run `kungfu agent brief`, then guide me through my first Project and Work. Keep me in my current agent, and use Kungfu as the durable Work layer.
```

**Start an Agent through Kungfu.** Use its familiar native console while Kungfu
keeps the Work behind it:

```sh
cd your-project
kungfu run codex
```

Use `claude`, `opencode`, or `amp` instead of `codex` when that is the agent you
already use. Pass a task to create the first Work directly:

```sh
kungfu run codex "Prepare the release notes"
```

**Open the optional global view later.** The Kungfu TUI and GUI can show and
manage Kungfu Projects and Work across Agent Sessions. They are sidecar views,
not a requirement for every Agent conversation.

> **Kungfu UNGFU™** · Never Guess. Facts Unfold. [Why this signature
> exists](docs/concepts/why-kungfu.md).

## What Kungfu preserves

Kungfu keeps the Work—not the chat—outside every Agent Session: its objective,
progress, evidence, next action, and completion state.

- **Work continuity.** Change the Agent without losing what was done, what
  remains, or which Work is continuing.
- **Verified project understanding.** Declared sources, important omissions,
  conflicts, decisions, and uncertainty remain visible instead of being guessed.
- **Inspectable history.** People and Agents can see what happened, what the
  next action is, and where the supporting evidence came from.
- **Completion authority.** An Agent can produce a result and its evidence;
  independent review and Kungfu settlement decide whether Work is complete.

The first visible value should arrive within minutes. The deeper value appears
over the following days, when the same Work survives context loss, changed
understanding, failed attempts, handoff, and restart.

## Three proofs that Work is durable

Durable Work must answer three questions in order: can it survive a new Agent,
can it survive failure, and who is allowed to complete it?

### 1. Can Work survive a new Agent?

Yes. The first proof isolates continuity: one Work continues across two fresh
Agent Sessions without copied chat.

<!-- kungfu:auditable-demo:agent-work-lab-autoplay:start -->
[![Can Work survive a new Agent?](docs/qualification/evidence/auditable-demo/74f7cf0b18f261001755c43dfd2954262bdb32c865a34f8316e3ec38331fb35b/agent-work-lab-autoplay/demo.gif)](docs/qualification/evidence/auditable-demo/74f7cf0b18f261001755c43dfd2954262bdb32c865a34f8316e3ec38331fb35b/agent-work-lab-autoplay/public-evidence.json)
<!-- kungfu:auditable-demo:agent-work-lab-autoplay:end -->

### 2. Can Work survive failure?

Yes. The second proof moves from mechanism to real failure conditions. Inside
a disposable Project, the connection drops, a new process resumes, that process
crashes, and both Attempts remain under the same Work.

<!-- kungfu:auditable-demo:project-tour-episode-1:start -->
[![Can Work survive failure?](docs/qualification/evidence/auditable-demo/6751bfdf7a27dd2c4b0c3f0916a512fb7abd172543c94dee220b41a0d679632e/project-tour-episode-1/demo.gif)](docs/qualification/evidence/auditable-demo/6751bfdf7a27dd2c4b0c3f0916a512fb7abd172543c94dee220b41a0d679632e/project-tour-episode-1/public-evidence.json)
<!-- kungfu:auditable-demo:project-tour-episode-1:end -->

Work survival is only the first step. If an Agent can declare its own result
complete, continuity still is not trustworthy.

### 3. Who is allowed to complete Work?

Only the governed review and settlement path—not the Agent that did the work.
The third proof separates Agent exit, independent review, and Kungfu settlement.
An Agent can produce the candidate and evidence; it cannot approve its own Work.

<!-- kungfu:auditable-demo:project-tour-episode-2:start -->
[![Who is allowed to complete Work?](docs/qualification/evidence/auditable-demo/2ceca18c5d030d98f693e433bad4981c7931a2ca1f4b2efcbdc7d63538e642db/project-tour-episode-2/demo.gif)](docs/qualification/evidence/auditable-demo/2ceca18c5d030d98f693e433bad4981c7931a2ca1f4b2efcbdc7d63538e642db/project-tour-episode-2/public-evidence.json)
<!-- kungfu:auditable-demo:project-tour-episode-2:end -->

These are bounded exact-artifact demonstrations—not provider rankings,
production certification, or authority to complete real Work. See the
[animation technical specification and auditable evidence](docs/qualification/auditable-demo-artifact-pipeline.md).

Open the optional terminal view whenever you want the larger Work picture:

```sh
kungfu
```

Getting Started leads to the same Agent-first prompt. Keep your familiar Agent
interface as the primary workspace and open Kungfu when you need a global view,
a handoff, or an explicit review.

## One Work, several ways in

A **Project** remembers where related Work belongs. A **Work** keeps one durable
objective and its current truth. An **Attempt** records what one Agent tried,
including failure, without replacing or erasing the Work.

The same Work state is available from native Agent consoles, the Kungfu TUI and
GUI, the CLI, and APIs. You can spend most of your time in the Agent you already
know, then open Kungfu for a global view, a handoff, or an explicit review. If
another live Agent already owns a Work, Kungfu stops a second writer instead of
letting two Agents silently diverge.

## Go deeper when you need to

The README stops at the product entry. Detailed implementation, evidence, and
claim boundaries live in their own maintained routes:

- **Use and understand Kungfu:** [System Overview](docs/concepts/system-overview.md),
  the [Documentation Guide](docs/README.md), and the complete
  [Documentation Map](docs/MAP.md).
- **Build or contribute:** [Contributing to Kungfu](CONTRIBUTING.md),
  [AGENTS.md](AGENTS.md), [Verified Context for Agents](docs/guides/xinfa-agent-context.md),
  and [runtime surface provenance](docs/concepts/runtime-surface-provenance.md).
- **Verify guarantees and current limits:** [Contracts](docs/qualification/contracts.md),
  [Known Limits](docs/qualification/known-limits.md), and the
  [KFD support matrix](docs/qualification/kfd-support-matrix.md).
- **Evaluate release, update, and migration behavior:**
  [Upgrade Kungfu](docs/guides/upgrading.md) and the
  [Exit and version compatibility policy](docs/guides/exit-and-version-compatibility.md).
- **Evaluate the wider ecosystem thesis:** the
  [Agent Supply Chain architecture](docs/architecture/agent-supply-chain.md).

Kungfu v4 is **Coming soon**. The current repository contains source-built
capabilities and retained qualification evidence; public release artifacts are
not available yet. Exact status and non-claims live in
[Known Limits](docs/qualification/known-limits.md).

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

## Open system repositories

Kungfu's protocol, release infrastructure, build environments, and public
sites are developed in the open:

- [Buildchain](https://github.com/kungfu-systems/buildchain) — auditable build
  and release infrastructure with verifiable Release Passports.
- [KFD](https://github.com/kungfu-systems/kfd) — the open engineering standard
  for reliable action and continuity under uncertainty.
- [Build Images](https://github.com/kungfu-systems/build-images) — source for
  the reproducible environments used to build Kungfu system artifacts.
- [kungfu.tech source](https://github.com/kungfu-systems/site-kungfu-tech) —
  source for the public product site.
- [libkungfu.dev source](https://github.com/kungfu-systems/site-libkungfu-dev) —
  source for the developer and agent surface.
- [All public repositories](https://github.com/kungfu-systems) — the complete
  organization-level source map.
