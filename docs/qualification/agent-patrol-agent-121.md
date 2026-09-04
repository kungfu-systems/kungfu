# Kungfu Agent Patrol on agent-121

This Patrol is an independent, non-required observation lane for the bounded
OpenCode repository-work experiment. It keeps probabilistic local-model load
off agent-120, which remains the Dev build primary.

## Execution contract

- Workflow: `.github/workflows/kungfu-agent-patrol.yml`
- Daily heartbeat: one run at 02:00 Asia/Shanghai every day
- Daily lightweight slot: Tuesday through Sunday
  (`0 18 * * 1-6` UTC), one fixed fixture
- Weekly deeper slot: Monday (`0 18 * * 0` UTC), two fixtures selected from
  the three-fixture catalog
- Weekly real-source observation: Thursday 04:00 Asia/Shanghai
  (`0 20 * * 3` UTC), one real-module fixture
- Monthly qualification: Monday 04:00 Asia/Shanghai after the first UTC
  Sunday. GitHub's POSIX scheduler invokes `0 20 * * 0` every Sunday; the
  selector emits `monthly-skip` outside the first-Sunday window before any
  model process runs.
- Protected post-merge candidate qualification: a `push` to the default branch
  only when the Patrol workflow, runtime, fixture, oracle, package, image, or
  model binding changes
- Manual trigger: `workflow_dispatch` with an explicit `light`, `deep`,
  `real-snapshot`, `qualification`, or `candidate` mode on the protected
  default branch only
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
- Job timeout: 90 minutes for light, deep, and weekly observation; 240 minutes
  only for the three-trial monthly or candidate qualification
- Credentials: none admitted to the model or Dogfood payload

`developer/agent-patrol/select.mjs` owns the trigger-to-plan contract. The
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

The `real-snapshot` mode is a separate observation lane. It selects only
`kungfu-agent-patrol-real-module-snapshot-v1`: a content-rooted slice of the
checked-out Kungfu Agent Patrol implementation and tests. Its
committed manifest binds every tracked regular file by mode, bytes, lines, and
SHA256 plus one canonical tree root. The materializer reads the exact protected
commit through Git, verifies the manifest, copies no `.git` metadata, and then
applies one deterministic regression to
`developer/agent-patrol/classify.mjs`.

Agent A remains read-only. Agent B may change only that one module. The visible
test checks stable Finding identity across volatile large numeric run IDs; a
second variant is executed by an external hidden verifier that is never copied
into the agent workspace. The reference repair, protected-path negative test,
symlink rejection, exact initial tree, and source tree root are deterministic
local contracts.

The protected manual qualification established that the pinned image can
execute this lane on agent-121. The weekly lane now records one advisory
observation without replacing the synthetic deep suite. Monthly and post-merge
candidate plans repeat the same fixture three times so one deterministic
decision can distinguish `qualified`, `hold`, and `insufficient-history`.

The workflow is classified as `qualification` authority with a `diagnostic`
receipt. It cannot publish a product, move a release channel, become a required
Dev/release gate, or run fork pull-request code.

## Outcome policy

| Outcome | Workflow | Dogfood |
| --- | --- | --- |
| Deterministic oracle passes | green | no Finding |
| Model, tool, timeout, continuity, exactness, or oracle outcome with valid bounded evidence | green advisory; qualification may hold | capture a novel Finding or reuse the existing one |
| Runner environment or Warrant/sandbox scope failure | red | capture or reuse a Finding when bounded evidence is available |
| Missing, malformed, mismatched, or unrooted evidence | red | fail closed; do not invent a Finding |
| Dogfood profile, lookup, capture, or receipt failure | red | fail closed |

`developer/agent-patrol/classify.mjs` computes a stable failure fingerprint from
the experiment identity, pinned runtime, failure category, and a normalized
message root. Volatile content roots, commit hashes, absolute paths, and large
numeric identifiers do not create new identities.

`developer/agent-patrol/dogfood-capture.mjs` owns the only mutation path. It:

1. ensures the dedicated persistent project workspace;
2. recovers the exact Dogfood Profile root through its plan/apply contract;
3. looks up the stable Finding ID;
4. returns `deduplicated` when the Finding already exists; and
5. calls only `dogfood capture` when the identity is novel.

The adapter has no `dogfood admit` or `dogfood transition` path. Every bounded
receipt states `issueAdmitted: false`.

## Capability Receipts and qualification

`framework/work/agent-repository-work/report.mjs` converts each validated report,
classification, and Dogfood receipt into one
`kungfu.agent-patrol.capability-receipt/v1`. The canonical receipt binds:

- the exact Git commit and tree, plan root, fixture identity, pinned image,
  model, runner, context, trial number, and observation time;
- report, classification, Warrant, session, continuation, external-verifier,
  and Dogfood receipt roots;
- execution, functional, scope, continuity, exactness, evidence, and efficiency
  states; and
- externally recomputed changed-path/file/line/byte counts, mutation-site
  contact, structural/symbol fingerprint roots, elapsed time, and process
  failure count.

The receipt contains no source, patch, prompt, transcript, raw response, hidden
test, credential, or private path. A functional and scope pass with an
exactness failure remains separately queryable instead of being collapsed into
an undifferentiated failure.

Validated canonical bytes are stored below:

```text
$HOME/.local/state/kungfu-agent-patrol/capability-receipts/v1/
```

The store opens a new content-addressed path exclusively. Identical replay
returns `already-present`; different bytes at the same root fail closed.
Nothing overwrites, renames over, deletes, purges, or compacts an existing
receipt.

The workflow selects at most 128 validated receipts into each 14-day and
30-day trend. Groups bind one exact provider/image/model/runner/context tuple
and fixture, and report pass count/rate, duration p50/p95, recurrent failure
identities, and qualification state. The physical store remains append-only.

Monthly and candidate plans require three current trials. A model-capability
dimension that does not pass produces a non-blocking `hold`. Missing or corrupt
evidence, runner failure, Warrant/sandbox escape, verifier-integrity failure,
or Dogfood-integrity failure remains workflow-blocking. No decision promotes a
model/image tuple or becomes a Dev or release gate.

## Dogfood authority and privacy

The owning authority is the persistent project workspace:

```text
$HOME/.local/state/kungfu-agent-patrol/.kungfu
```

The workflow assembles a separate retained directory and audits every JSON
file against a path allowlist, a 256 KiB per-file budget, a 4 MiB total budget,
forbidden payload fields, private paths, symlinks, and key material. It uploads
only the plan, bounded reports, classifications, Dogfood receipts, Capability
Receipts, store receipts, 14/30-day trends, qualification decision, and audit
receipt. It does not upload provider transcripts, raw prompts, credentials,
signed URLs, the native Fact store, generated capture intents, or disposable
workspaces.

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

For the real module lane, also verify:

1. `mode=real-snapshot` selected exactly one fixture;
2. the report bound the protected `sourceHead` and committed `sourceTreeRoot`;
3. the OpenCode image ran the visible Node test in both fresh sessions;
4. only `developer/agent-patrol/classify.mjs` changed;
5. visible and hidden checks passed; and
6. the Capability Receipt separated functional, scope, and exactness states;
7. replaying identical receipt bytes returned `already-present`; and
8. a qualification-equivalent run emitted `qualified`, `hold`, or
   `insufficient-history` with exact reasons.
