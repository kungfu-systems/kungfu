# Local-agent repository-work experiment

This independent experiment asks whether Kungfu can carry enough bounded work
state between two fresh OpenCode processes to support a moderately complex
repository repair. It is deliberately separate from Auditable Demo,
Qualification Lab, release Gates, public capability claims, and model ranking.

```text
49-file / 2433-line Python fixture with a seeded defect
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
  --base-url http://host.docker.internal:11435/v1
```

The resulting `agent-repository-work-report.json` records execution,
correctness, scope, continuity, evidence, efficiency, and residual limitations.
A pass is bounded to this fixture, image, model, endpoint, and runner.

## Residual limitations

This experiment does not establish multi-day durability, concurrent editing,
arbitrary repository competence, provider superiority, production safety,
GUI/TUI parity, or release readiness. A single passing run is evidence that the
tested path bore this workload; it is not a generalized product claim.
