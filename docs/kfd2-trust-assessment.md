# KFD-2 trust assessment in a live workspace

Kungfu records work continuously, but it does not run a full trust analysis
after every command or log line. KFD-2 evaluates a concrete claim when a human
or agent needs to decide whether that claim is fit for a stated purpose.

This is the user and runtime model accepted by
[ADR-0052](../framework/core/docs/adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md).
The implementation is staged; example names describe the intended contract.

## From status to replay, only when needed

The Desktop experience uses progressive disclosure:

```text
What is the current state?
  -> Can I trust it for this purpose?
  -> What evidence supports it?
  -> How did the work happen?
  -> What do the raw records show?
```

A routine status check starts with progress, blocker, owner, and next action.
The associated TrustReport explains whether the result is suitable for handoff,
release, customer communication, or another declared purpose. Users open proof,
Episode timeline, or replay only when the report is stale, conflicted,
insufficient, high-risk, or under investigation.

Replay remains essential, but it is not the price of every status check.

## What causes an assessment?

An agent may report many observations while working. Kungfu continues to append
and admit those facts without performing a full assessment each time.

KFD-2 is triggered when:

- an agent or user makes a load-bearing claim such as `task-completed`;
- a milestone, checkpoint, handoff, or Episode seal is reached;
- a user or agent asks whether a result can be trusted for a purpose;
- a guarded action such as release requires fresh trust;
- relevant evidence, declarations, or assessment policy changes.

The assessment always names a claim, purpose, pinned cut, declaration roots,
and policy version. An agent's own completion statement can trigger the job,
but it cannot prove itself without independent admitted evidence.

## Recording and assessment stay separate

The normal Episode close path returns after committing durable work facts and a
sealed root. It also persists, or makes deterministically discoverable, any
required assessment request:

```text
Episode sealed
Trust status: pending
Assessment: task-completed for handoff at root abc...
```

The full assessment runs beside the recording path. Failure or timeout does not
undo the sealed Episode. A high-risk action may explicitly wait for a fresh
report and fail closed if the report remains pending or insufficient.

## Desktop: the workspace master coordinates

For each live `.kungfu` data root, the workspace master observes relevant
claims, schedules assessment jobs, deduplicates requests, tracks dependencies,
invalidates stale reports, retries workers, and publishes status updates.

The per-user supervisor only starts and routes workspace masters. The master is
not the fact authority and does not contain every domain assessor. Requests,
reports, Episodes, and proof remain durable in the workspace ledger.

A typical process assessment is:

```text
workspace master sees a claim
  -> records AssessmentRequested
  -> starts or assigns an assessor worker
  -> worker reads pinned sealed journals through mmap
  -> worker writes through its own assessor journal
  -> master admits the result
  -> GUI receives the TrustReport update
```

The worker has its own Kungfu location and single-writer journal. It never
concurrently writes the master's mmap journal. Because the work Episode is
already sealed, the report is stored in a separate Assessment Episode that
depends on the work Episode, declarations, and query proof.

## Embedded: the same capability in threads

An embedded libkungfu consumer does not need the Desktop process tree. It can
run trusted assessors in controlled worker threads:

```text
embedded host
  -> ThreadExecutor
  -> same AssessmentRequest
  -> same pinned read
  -> same Assessment Episode and TrustReport
```

Process and thread executors are deployment profiles, not different trust
models. In-process execution still preserves explicit location identity,
single-writer report commit, pinned cuts, timeout/cancellation, and durable
results. Thread-local state may help bind context, but it cannot be the only
persisted identity.

Untrusted native assessors or libraries needing crash isolation remain process
or sandbox candidates.

## Report freshness is visible

The GUI and CLI expose assessment state rather than hiding recomputation:

```text
pending
running
fresh
stale
insufficient-evidence
conflicted
unverifiable
failed-retryable
```

New unrelated facts do not invalidate a report. A relevant correction,
retraction, declaration change, or policy change does. A stale report keeps its
historical meaning at its original cut while a successor is evaluated.

This gives users a concise answer first, an honest boundary around that answer,
and a direct path to proof or replay when deeper inspection is warranted.
