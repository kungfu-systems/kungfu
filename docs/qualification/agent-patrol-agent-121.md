# Kungfu Agent Patrol on agent-121

This Patrol is an independent, non-required observation lane for the bounded
OpenCode repository-work experiment. It keeps probabilistic local-model load
off agent-120, which remains the Dev build primary.

## Execution contract

- Workflow: `.github/workflows/kungfu-agent-patrol.yml`
- Schedule: one run at 02:00 Asia/Shanghai every day
- Daily lightweight slot: Tuesday through Sunday
  (`0 18 * * 1-6` UTC), one fixed fixture
- Weekly deeper slot: Monday (`0 18 * * 0` UTC), two fixtures selected from
  the three-fixture catalog
- Manual trigger: `workflow_dispatch` with an explicit `light` or `deep` mode
  on the protected default branch only
- Runner: `agent-121-kungfu-systems`
- Required labels: `agent-121`, `kungfu-agent-patrol`
- Image:
  `ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3`
- Model: `qwen3-coder:30b-opencode-64k`
- Endpoint: the explicit loopback OpenAI-compatible tunnel on port `11435`
- Container runtime: a runner-owned rootless Docker socket at
  `/run/user/996/docker.sock`
- Container identity: the adapter verifies Docker `SecurityOptions`; only a
  rootless daemon uses container `0:0`, which maps back to the unprivileged
  runner account and preserves writable bind-mount ownership. Rootful daemons
  continue to use the invoking host UID/GID.
- Checkout transport: the exact protected-source checkout forces Git HTTP/1.1
  through step-scoped environment configuration. This avoids reproducible
  HTTP/2 stream cancellation and early-EOF failures observed on agent-121
  without changing the source ref, credentials, runner-global Git config, or
  any later Patrol step.
- Concurrency: one Patrol run at a time
- Credentials: none admitted to the model or Dogfood payload

`framework/agent-patrol/select.mjs` owns the trigger-to-plan contract. The
lightweight mode always runs `incident-board-lease-v1` with a 600-second
per-session timeout. The deeper mode runs two fixtures with a 900-second
per-session timeout and rotates the starting fixture from the stable GitHub
workflow run number:

```text
lease + recovery
recovery + combined replay
combined replay + lease
```

Rerunning one workflow attempt preserves the same rotation key and suite. The
shared non-cancelling concurrency group serializes scheduled and manual runs,
so the two modes cannot contend for agent-121.

The workflow is classified as `qualification` authority with a `diagnostic`
receipt. It cannot publish a product, move a release channel, become a required
Dev/release gate, or run fork pull-request code.

## Outcome policy

| Outcome | Workflow | Dogfood |
| --- | --- | --- |
| Deterministic oracle passes | green | no Finding |
| Model, tool, timeout, continuity, Warrant, or oracle failure with valid bounded evidence | green advisory | capture a novel Finding or reuse the existing one |
| Runner environment failure | red | capture or reuse a Finding when bounded evidence is available |
| Missing, malformed, mismatched, or unrooted evidence | red | fail closed; do not invent a Finding |
| Dogfood profile, lookup, capture, or receipt failure | red | fail closed |

`framework/agent-patrol/classify.mjs` computes a stable failure fingerprint from
the experiment identity, pinned runtime, failure category, and a normalized
message root. Volatile content roots, commit hashes, absolute paths, and large
numeric identifiers do not create new identities.

`framework/agent-patrol/dogfood-capture.mjs` owns the only mutation path. It:

1. ensures the dedicated persistent project workspace;
2. recovers the exact Dogfood Profile root through its plan/apply contract;
3. looks up the stable Finding ID;
4. returns `deduplicated` when the Finding already exists; and
5. calls only `dogfood capture` when the identity is novel.

The adapter has no `dogfood admit` or `dogfood transition` path. Every bounded
receipt states `issueAdmitted: false`.

## Dogfood authority and privacy

The owning authority is the persistent project workspace:

```text
$HOME/.local/state/kungfu-agent-patrol/.kungfu
```

The workflow uploads only the bounded Patrol plan, per-fixture repository-work
reports, classifications, and capture receipts. It does not upload provider
transcripts, raw prompts, credentials, signed URLs, the native Fact store, or
generated capture intents.

The native Dogfood Inbox is a federated projection, not one atomic global
database. A consumer that needs to inspect this runner-owned Finding must
include the agent-121 component workspace or an explicitly admitted portable
copy. The Patrol does not claim automatic cross-machine replication.

## Runner prerequisites

Before enabling the workflow, verify all of the following on agent-121:

- the runner is restricted to `kungfu-systems/kungfu`;
- the dedicated `kungfu-agent-patrol` label is present;
- the runner account can use its dedicated rootless Docker daemon without
  membership in the host `docker` group;
- the exact image digest is preloaded;
- Node major version 24 is active;
- the loopback port `11435` model endpoint is reachable from the rootless
  Docker bridge as `host.docker.internal`;
- `$HOME/.local/state/kungfu-agent-patrol` is writable by only the runner
  account; and
- no unknown or unmounted disk is touched.

Runner-group changes, Docker account permissions, persistent endpoint tunnels,
image loading, and service changes are real-system writes. Apply them only
after an exact command, impact, rollback, and explicit authorization have been
reviewed.

## Verification

Local deterministic and native temporary-workspace coverage:

```bash
./shifu test:agent-patrol
./shifu check:gate-catalog
```

After activation, dispatch the protected-branch workflow and verify:

1. a manual `light` dispatch ran only `incident-board-lease-v1`;
2. a manual `deep` dispatch ran the exact two-fixture suite in `plan.json`;
3. both jobs ran on `agent-121-kungfu-systems`;
4. the exact image, model, source commit, endpoint, and fixture IDs were bound;
5. a passing report produced `not-required`;
6. a controlled failure produced `captured`;
7. replaying that failure produced `deduplicated` with the same Finding root;
8. every receipt retained `issueAdmitted: false`; and
9. a controlled runner-integrity failure left the job red.
