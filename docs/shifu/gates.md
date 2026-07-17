# Shifu Gate control plane

Shifu Gate is the project-independent control plane for declaring, explaining,
planning, executing, and auditing quality and release gates. A project owns the gates it needs and
the policy profiles that select them; Shifu owns the schema, validation rules,
and command semantics. Buildchain may schedule a future plan, but it does not
reinterpret the registry.

Execution remains local and bounded: Shifu runs a selected dependency closure
and emits one source-bound receipt, while Buildchain remains responsible for
allocating remote runners and aggregating cross-platform results. Gate execution
does not replace existing task aliases or change CI policy.

## Authority boundary

| Concern | Owner |
|---|---|
| Gate schema, validation, explanation, matrix, dependency plan | Shifu |
| Concrete gate ids, actions, documentation and profile decisions | consuming project |
| Runner allocation, cross-platform scheduling and aggregate CI checks | Buildchain |
| Required-check changes, release promotion and policy approval | project maintainers |

The canonical discovery root is [`gate-contract.json`](gate-contract.json).
The registry, plan, and receipt schemas are
[`gate-registry-v1.schema.json`](schema/gate-registry-v1.schema.json) and
[`gate-plan-v1.schema.json`](schema/gate-plan-v1.schema.json), and
[`gate-receipt-v1.schema.json`](schema/gate-receipt-v1.schema.json). A consuming
project normally commits `shifu.gates.json`; `--registry FILE` or
`SHIFU_GATE_REGISTRY` selects another instance without changing the contract.

## Registry model

Light and heavy gates use the same declaration. `cost.class` affects planning
and later scheduling; it does not create a second gate type.

Every gate declares:

- a stable id, title, summary, category, and repository-relative Markdown doc;
- dependencies, supported platforms, and required runner capabilities;
- a light or heavy cost class and an explicit timeout;
- one structured action: a Shifu task, an argv vector, or a named handler;
- expected artifacts and receipt expectation.

Raw shell strings are not an action kind. Structured actions keep quoting,
platform behavior, review, and future Buildchain translation explicit.

Every profile must decide every gate as `required`, `advisory`, or `off`, with a
reason. Missing decisions are invalid rather than silently defaulting to off.
A dependency cannot have a weaker profile mode than its dependent gate because
that would hide an effective policy upgrade inside the planner.

## Commands

```sh
./shifu gate contract
./shifu gate schema registry
./shifu gate schema plan
./shifu gate validate --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate list --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate explain source.contract --profile development \
  --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate matrix --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate plan release --platform linux \
  --registry docs/shifu/examples/gates/minimal.gate-registry.json --json
./shifu gate run fixture.left fixture.right \
  --registry docs/shifu/examples/gates/execution.gate-registry.json --json
./shifu gate run --profile success \
  --registry docs/shifu/examples/gates/execution.gate-registry.json \
  --receipt build/gate-receipts/success.json
./shifu gate receipt validate build/gate-receipts/success.json \
  --registry docs/shifu/examples/gates/execution.gate-registry.json --json
```

`validate` is the bootstrap primitive: it parses and reports an invalid
registry without first requiring that registry to be valid. It rejects unknown
fields, duplicate ids, unknown dependencies, dependency cycles, unknown profile
entries, missing profile entries, and dependency-mode contradictions.

`plan` selects required gates by default, optionally includes advisory gates,
closes dependencies, and emits deterministic topological groups sorted by gate
id. It carries platform constraints, runner capabilities, cost, structured
actions, selection reasons, skipped gates, and unsupported gates. A required or
explicitly selected gate that is unsupported on the requested platform makes
the plan fail; it is never presented as a successful skip.

`--gate GATE` is a diagnostic selection override. It may plan a gate that the
profile marks off, but the output is `qualifying: false`: selection does not
rewrite project policy and cannot later produce a qualifying profile receipt.

## Execution and receipts

`run GATE...` closes and executes dependencies once, but it is always a
diagnostic run. `run --profile PROFILE` is the only qualification candidate.
It executes deterministic topological groups sequentially on the local runner;
Buildchain may distribute the same planned groups later without changing gate
meaning. `--include-advisory` runs advisory selections without making their
failure block required qualification. `--capability CAP` declares additional
runner capabilities; `node` is inherent because the Gate engine is already
running under Shifu's pinned Node toolchain.

Each result is one of `pass`, `fail`, `advisory-fail`, `unsupported`, `skip`,
or `error`. A failed dependency skips its dependents, and the receipt retains a
copyable explicit gate reproduction argv. Task actions re-enter the native
Shifu launcher (`shifu` or `shifu.cmd`); argv actions use `shell: false`; named
handlers must be registered by an embedding controller. Raw shell strings are
never synthesized.

Project measurement coverage distinguishes those execution boundaries. Task
and argv Gates retain the ordinary `shifu.gate-receipt/v1`. A handler Gate
retains `kungfu.gate-controller-receipt/v1`, captured from the exact successful
workflow job named by its controller binding. The controller receipt binds the
same source, registry and Gate definition plus the workflow, job, adapter,
runner and job timestamps; a task receipt cannot stand in for a handler.

The unified receipt binds all of the following:

- source SHA and dirty state;
- registry, plan, gate definition, and action digests;
- actual platform and declared runner capabilities;
- expected versus attempted actions, status, duration, exit code, and signal;
- declared artifact presence and safe repository-relative evidence pointers.

The executor never copies child stdout, stderr, inherited environment values,
or absolute paths into the receipt; bounded reason strings redact repository,
home, temporary, URL, and secret-like assignment material. A gate that declares required
gate-specific evidence receives a temporary `SHIFU_GATE_EVIDENCE_FILE`; it
must write `{ "schema": "...", "pointers": [...] }` with the declared schema
and repository-relative refs. The temporary file is deleted after the run.

A receipt is qualifying only when it came from a full profile, the source is a
clean Git revision, the registry and definitions are current, and every
required action was attempted and passed. Explicit overrides, dirty checkouts,
stale source SHA, changed definitions, missing result rows, missing required
artifacts, or missing required evidence cannot qualify. `gate receipt validate`
recomputes these facts instead of trusting the stored `qualifying` boolean.
Receipt files should be written to an ignored output such as `build/` or to an
external evidence directory so writing the receipt does not dirty its own
source checkout.

All inspection commands support `--json`. Each JSON result carries a stable
schema discriminator such as `shifu.gate-list/v1`,
`shifu.gate-detail/v1`, `shifu.gate-matrix/v1`, or
`shifu.gate-plan/v1`.

## Compatibility and migration

The v1 registry rejects unknown fields so spelling errors and policy drift fail
closed. Additive optional fields may extend v1; changing field meaning, making
an optional field required, or changing selection semantics requires a new
contract major.

Existing `./shifu <task>` commands remain unchanged. Later migration may turn
old `check:*`, `verify`, or qualification commands into aliases for registered
actions, but the aliases cannot remain a second policy source. Until migration
is complete, old required gates remain in force and the stricter result wins.

The project-neutral example is
[`minimal.gate-registry.json`](examples/gates/minimal.gate-registry.json).
Negative fixtures under [`examples/gates/invalid/`](examples/gates/invalid/)
keep each fail-closed rule executable.
