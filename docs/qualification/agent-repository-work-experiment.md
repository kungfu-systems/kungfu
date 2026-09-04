# Local-agent repository-work experiment

This independent experiment asks whether Kungfu can carry enough bounded work
state between two fresh OpenCode processes to support a moderately complex
repository repair. It is deliberately separate from Auditable Demo,
Qualification Lab, release Gates, public capability claims, and model ranking.

```text
49-file Python fixture selected from a three-entry seeded-defect catalog
-> fresh Agent A investigates under a read-only Warrant
-> deterministic assessment accepts only a bounded partial Claim
-> Kungfu admits a content-rooted continuation envelope
-> fresh Agent B receives no transcript or human task restatement
-> Agent B may change only three production modules
-> an external visible-plus-hidden oracle decides pass or fail
```

The fixture implements an append-only incident board. Its seeded defect permits
an expired lease to complete work and counts historical retry completions more
than once after restart. The repository uses only the Python standard library.

The catalog derives three byte-bounded fixtures from that repository:

| Fixture | Seeded boundary | Writable Warrant |
| --- | --- | --- |
| `incident-board-lease-v1` | expired-lease completion authorization | `incident_board/lease.py` |
| `incident-board-recovery-v1` | duplicate-completion restart replay | `incident_board/replay.py` |
| `incident-board-replay-v1` | combined lease, command, and replay repair | three production modules |

Each derived fixture pre-applies the independent reference repair outside its
seeded boundary. The visible and hidden external oracle still checks the full
repository behavior, so a focused repair cannot pass by regressing another
boundary.

## Real Kungfu module snapshot

The `real-snapshot` Patrol mode adds a separate fixture without replacing the
synthetic catalog. Its committed manifest binds a dependency-closed slice of
the actual Agent Patrol classifier, selector, Dogfood capture adapter, report
validator, fixture catalog, and tests.

The exact protected commit is the byte source. The materializer accepts only
tracked regular files whose mode, size, line count, and SHA256 match the
manifest, verifies a canonical tree root, copies the slice into a disposable
workspace without Git metadata, and applies one deterministic mutation:
large numeric failure identifiers stop being normalized in
`developer/agent-patrol/classify.mjs`.

The visible regression checks that two failures differing only in volatile run
IDs resolve to one Finding identity. The external hidden verifier repeats that
boundary with different identifiers and paths. Agent A receives a read-only
mount; Agent B may modify only `developer/agent-patrol/classify.mjs`; the
reference root and all other snapshot paths remain protected. This makes the
result evidence about a real Kungfu module slice while retaining deterministic
completion authority.

## Trust boundaries

- Agent A runs with a read-only workspace mount. A byte-level tree comparison
  must also prove zero production changes.
- Agent B receives a writable disposable fixture, but its Warrant permits only
  `incident_board/commands.py`, `incident_board/lease.py`, and
  `incident_board/replay.py`.
- The reference repair and hidden oracle stay on the host and are never mounted
  into either Agent container.
- A successful OpenCode process exit and natural-language self-report are
  observations, not completion authority.
- The deterministic oracle rejects protected-file changes, added files,
  symlinks, visible-test failure, or hidden-test failure.
- Retained evidence contains content roots and bounded outcome dimensions, not
  provider transcripts, repository bytes, credentials, or hidden tests.

The machine-readable contract is
[`contract.json`](../../tests/qualification/agent-repository-work/contract.json).

## Local deterministic checks

The local test does not invoke a model:

```bash
./shifu test:agent-repository-work
```

It proves that the seeded fixture fails at the intended two tests, the
independent reference repair passes all visible and hidden checks, and tampering
outside the three-file Warrant fails closed.

## Trusted agent-120 run

The manual
[`opencode-agent-repository-work.yml`](../../.github/workflows/opencode-agent-repository-work.yml)
workflow is the authoritative execution path. It requires:

- trusted self-hosted runner `agent-120-kungfu-systems`;
- the digest-pinned `opencode-ci` image;
- local model `qwen3-coder:30b-opencode-64k`;
- the explicit OpenAI-compatible endpoint on port `11435`;
- two fresh OpenCode processes launched through native `kungfu run agent`;
- a disposable workspace and fresh Kungfu/XDG state;
- read-only container roots, dropped capabilities, no-new-privileges, bounded
  memory, CPU, PIDs, and timeout; and
- one bounded report retained for 14 days.

For a direct trusted-host invocation:

```bash
./shifu build:core
./shifu qualify:agent-repository-work -- \
  --output /tmp/kungfu-agent-repository-work \
  --image ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3 \
  --model qwen3-coder:30b-opencode-64k \
  --base-url http://host.docker.internal:11435/v1 \
  --fixture incident-board-lease-v1
```

The resulting `agent-repository-work-report.json` records execution,
correctness, scope, continuity, evidence, efficiency, and residual limitations.
A pass is bounded to this fixture, image, model, endpoint, and runner.

## Independent agent-121 Patrol

The scheduled
[`kungfu-agent-patrol.yml`](../../.github/workflows/kungfu-agent-patrol.yml)
workflow repeats this bounded experiment on agent-121 without becoming part of
Dev, release, or required-check authority. Model and external-oracle failures
remain advisory; runner and evidence-integrity failures remain blocking.

The Patrol classifies failures deterministically and captures only novel native
Dogfood Findings. A stable failure fingerprint resolves recurrence to the
existing immutable Finding before any write. Passing runs create no Finding,
and the Patrol has no automatic Issue admission path. See the
[agent-121 Patrol runbook](agent-patrol-agent-121.md) for the exact trigger,
privacy, deduplication, authority, and activation boundaries.

The qualified real snapshot runs once each Thursday at 04:00 Asia/Shanghai as
an advisory observation. A strict monthly plan and a protected-default-branch
post-merge candidate plan each repeat it three times. Every trial emits a
privacy-bounded, content-addressed Capability Receipt. Append-only receipt
history feeds bounded 14-day and 30-day trends and a deterministic
`qualified`, `hold`, or `insufficient-history` decision without making the
probabilistic result a Dev or release gate.

## Residual limitations

This experiment does not establish multi-day durability, concurrent editing,
arbitrary repository competence, provider superiority, production safety,
GUI/TUI parity, cross-machine Dogfood replication, or release readiness. A
passing run is evidence that the selected fixture, runtime, and runner bore that
workload; it is not a generalized product claim.
