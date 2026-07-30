# Kungfu

**Your agent shouldn't start over when the chat ends.**

Kungfu helps a fresh agent continue the same work without asking you to explain
it all again. It does this from declared project sources, makes missing or
conflicting context visible, and preserves enough structure to continue without
reconstructing everything from conversation history.

> **Kungfu UNGFU™** · Never Guess. Facts Unfold. [Why this signature
> exists](docs/concepts/why-kungfu.md).

The intended first-release path is:

```sh
cd your-project
kungfu run agent
```

**Status: Coming soon.** `kungfu run agent` is the target entrypoint for the
first public CLI, which is now under qualification. Until public artifacts are
available, you can [build the current source](#build-from-source).

<!-- kungfu:auditable-demo:start -->
## See a fresh Agent continue the same Work

**One Work. Two fresh Agent processes. No copied chat.**

Session 1 stops with a partial result. Session 2 starts without the previous
conversation, recovers what was done and what remains, then finishes the same Work.

[![Kungfu Agent Work Lab showing a fresh Agent continuing the same Work without copied chat](docs/qualification/evidence/auditable-demo/0ff4cc1ef018544ad752eb08cf2fec205fe8d1bbedeb41b0111566732919b5e7/demo.gif)](docs/qualification/auditable-demo-artifact-pipeline.md)

<details>
<summary>How this exact installed-artifact demo was verified</summary>

This selectively rendered demo comes from one exact retained Linux build artifact.
The installed `kungfu agent-work-lab autoplay` command ran in a bounded PTY, the
required Buildchain Gate qualified its exact capture, and full media rendered only
from that passing Gate.

[Method and evidence](docs/qualification/auditable-demo-artifact-pipeline.md) · [source `b48d30166e26`](https://github.com/kungfu-systems/kungfu/commit/b48d30166e26dfceb873d1057e1db3c3e00c3385) · [workflow run](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808)

[Gate bundle](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759425334) `sha256:31a259eccd3a4f093eaad2be01bc6def399b1653a010a6949c0bf8fa903bd54b` · [media bundle](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759470968) `sha256:7fafb048c7133291602643beeb702bea58763863e533d696d6bc962f66e5981b` · [Release Passport](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759489175) `sha256:0ff4cc1ef018544ad752eb08cf2fec205fe8d1bbedeb41b0111566732919b5e7`

Evidence class: `exact-installed-artifact-agent-work-lab-autoplay/v1`. This proves only the exact
installed-artifact autoplay and named Gate/render path. The demo grants no
authorization from first-party/System identity, KFD compliance, Product System
metadata, local bundle presence, package metadata, registry history, scan output,
or standalone generation, and makes no production-deployment claim.

</details>
<!-- kungfu:auditable-demo:end -->

## What Kungfu preserves

- **Work continuity.** A fresh Agent can recover what was done, what remains,
  and which Work it is continuing.
- **Verified project understanding.** Declared sources, important omissions,
  conflicts, decisions, and uncertainty remain visible instead of being guessed.
- **Inspectable history.** People and Agents can see what happened, what the
  next action is, and where the supporting evidence came from.

The first visible value should arrive within minutes. The deeper value appears
over the following days, when the same work survives context loss, changed
understanding, failed attempts, handoff, and restart.

See the [continuity handoff](https://kungfu.tech/#continuity-demo) and
[how it was tested](https://kungfu.tech/how-tested/continuity/), or inspect the
[source protocol and retained evidence](docs/qualification/continuity-pilot.md).
The current result is preparatory fixture evidence—not a provider comparison,
multi-day durability or retention result, or FO10 qualification.

## Keep using the agents you already have

`kungfu run agent` is the golden path, not a required replacement for Codex,
Claude Code, OpenCode, VS Code, terminals, or other agent surfaces. The same
local contracts and work state remain available through the Kungfu CLI and APIs
when an Agent continues to run elsewhere.

## Build from source

Public release artifacts are not available yet. To evaluate the current source
tree:

```sh
git clone https://github.com/kungfu-systems/kungfu.git
cd kungfu
./shifu doctor
./shifu sync && ./shifu build
```

## Understand the system

If your goal is to understand Kungfu as a system, do not begin by comparing
repository directories and current modules side by side. Start with the
[Evolution Map](docs/evolution/README.md): it establishes the historical
pressures, abstraction compressions, and authority transitions that produced
the current cross-section. Then use its reader routes to enter the exact
current module, contract, and source authority for your question.

If you already have one bounded implementation or operational task, use
[AGENTS.md](AGENTS.md) and the task-specific Xinfa route instead of loading the
whole history first.

- [Start with Kungfu's longitudinal Evolution Map](docs/evolution/README.md)
- [Why Kungfu begins with a minimal human sovereign core](docs/concepts/bootstrapping-agent-work.md)
- [Inspect and reanalyze the bounded public work sample](https://kungfu.tech/about/bootstrapping/evidence/)
- [How the complete Kungfu system works](docs/concepts/system-overview.md)
- [Agent Supply Chain architecture and evaluation](docs/architecture/agent-supply-chain.md)
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

To discover the exact Fact and Episode invariants, their owners, current
evidence routes, and residual risks from a source checkout, run:

```sh
./shifu invariant:verify -- --list --json
```

The human route is [Invariant Verification](docs/qualification/invariant-verification.md).

## Trust, portability, and the open system

The following sections expose the release, migration, and interoperability
contracts for technical evaluation. They preserve the evidence behind Kungfu's
claims without making that evidence the first step in understanding the product.

### Release status

Kungfu v4 is **Coming soon**. Source-built capabilities and qualification
slices exist, but public packaging, cross-platform evidence, strong power-loss
durability, and the institutional profile remain staged unless linked evidence
says otherwise.

UNGFU is Kungfu's source-identifying signature, not a second product or runtime.
See [Why Kungfu](docs/concepts/why-kungfu.md) for the naming boundary.

The first public Alpha is additionally gated by one ordered activation
transaction. Artifact publication, Release Passport sealing, exact site
publication, public read-back, and installed-product qualification must all
bind the same product/site source SHAs, artifact root, version, tag, and
channel. Released evidence is synthesized only from those receipts; a
preparation file cannot make a released-use or first-use claim. See
[Trademark public-use qualification](docs/qualification/trademark-public-use.md).

An installed Kungfu gives a person or Agent the same direct answer:

```sh
kungfu release status
kungfu release verify <release-status-or-evidence.json>
kungfu release explain
```

The human result says what passed and what did not; `--json` returns the stable
KFD-3 surface. Before activation, the truthful answer is `VERIFIED, NOT
AVAILABLE`. These commands do not make trademark-registration, legal, or
first-use-date claims.

Design intent, implemented behavior, qualified guarantees, and released
artifacts are deliberately distinct. Before relying on a claim, check
[Contracts](docs/qualification/contracts.md),
[Known Limits](docs/qualification/known-limits.md), and the applicable retained
qualification evidence.

Kungfu's complete KFD-1 through KFD-13 adoption and claim boundary is published
in the generated [KFD support matrix](docs/qualification/kfd-support-matrix.md).
Source implementation, verification, Buildchain gating, and shipped release
support are reported separately; a declared badge is not a release
qualification.

Inspect the current checkout before installing dependencies or initializing a
Kungfu runtime:

```sh
./shifu kfd status
./shifu kfd query KFD-3 --json
./shifu kfd check --json
```

The first command gives an immediate human verdict. The JSON forms expose the
same checked-in facts and non-claims to an Agent. They qualify source evidence,
not an installed product: use `kungfu agent hub qualify` and
`kungfu agent hub verify` for the installed Agent Hub path.

### Exit and migration

Kungfu treats Exit and migration as a product contract. Qualified stable
releases on the same `major.minor` line preserve registered authoritative
semantics, not physical provider paths, caches, or presentation. The current v4
alpha remains exact-evidence-only; it does not yet carry that stable promise.

Read the [Exit, migration, and version compatibility policy](docs/guides/exit-and-version-compatibility.md)
for the support boundary, current qualification matrix, and non-claims. An
installed artifact exposes its exact policy and protocol inventory without
initializing a runtime:

```sh
kungfu exit verify --info --json
```

The public install/update claim is still closed. The exact current matrix,
one-command behavior, activation boundary, rollback guidance, and explicit
non-claims are in [Upgrade Kungfu](docs/guides/upgrading.md); source fixtures
and prepared package-manager adapters are not public release artifacts.

### Kungfu in the Agent Supply Chain

Kungfu is also the founding runtime proof for an open Agent Supply Chain:

```text
KFD-3 discovery -> Buildchain artifact evidence -> KFD-2 assessment
  -> libkungfu / .kungfu durable work facts -> independent Agent Hubs
```

Kungfu and libkungfu own the fourth layer: recording, ordering, querying,
verifying, exporting, and recovering durable work facts and Episodes. The
application still owns its domain facts, and JSON is an edge projection rather
than a second authority. The public KFD Agent Hub profile lets independently
owned products carry bounded responsibility objects across that edge while
each receiver retains admission.

The current proof is exact-source and first-party: source-built runtime slices,
retained qualification, and one OpenCode-shaped reference adapter. It does not
claim OpenCode endorsement, external vendor adoption, a second independent
production Hub, public Kungfu Cloud, stable cross-platform compatibility, or
physical power-loss qualification. Read the
[architecture and evaluation route](docs/architecture/agent-supply-chain.md).

If Kungfu is installed, ask the product itself. The first command runs the
bundled fixed KFD Hub 20 suite and explains the exact result; the second
independently rechecks the retained evidence:

```sh
kungfu agent hub qualify --output-dir ./kungfu-agent-hub-check
kungfu agent hub verify --qualification-dir ./kungfu-agent-hub-check
```

Use `--json` when an Agent is the reader. A pass proves only the named local
artifact, two isolated local authority domains, and the fixed KFD package cut.
It is not KFD certification, security assessment, production fitness,
remote-network interoperability, external adoption, or evidence for an
unobserved platform.

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
