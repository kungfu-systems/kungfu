---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: protocol-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-03
theme: project-cut-public-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-09-03
ai_provenance: GPT-5 via Codex on 2026-09-01; updated through 2026-09-03 from checked-in protocol code, boundary manifests, and golden fixtures, with no access to invisible model internals
---

# Project Cut protocol contract

`framework/project-cut` is the build-free, content-addressed protocol layer that
binds one declared source projection, one Xinfa Atlas, and an admitted Kungfu
Episode delta. It implements [KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623](../../docs/adr/KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623.md)
and [KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be](../../docs/adr/KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be.md).
The agent-first settlement surface implements
[KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf](../../docs/adr/KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf.md)
without changing the frozen `project.cut/v1` root contract. Explicit Git
history qualification implements
[KF-ADR-019f86da-4f90-7272-b883-cb90fc4613b1](../../docs/adr/KF-ADR-019f86da-4f90-7272-b883-cb90fc4613b1.md)
as a separate rooted observation layer.

The layer owns no source, Atlas, Episode, Mission, Go, or Git authority. It
validates references to those authorities and computes four deliberately
separate identities:

- `cutRoot`: SHA-256 of the canonical `project.cut.root-input/v1` semantic
  preimage, excluding `cutRoot`, receipts, publication coordinates, and the
  containing Git commit OID;
- `serializationRoot`: SHA-256 of canonical `project.cut/v1` JSON, including
  `cutRoot`;
- `artifactDigest`: SHA-256 of the exact artifact bytes that were inspected;
  and
- `receiptRoot`: SHA-256 of the receipt preimage.

`sha256-project-cut-canonical-json-v1` hashes canonical JSON without a trailing
newline. Canonical JSON sorts object keys by UTF-8 bytes, preserves
schema-declared array order, admits valid NFC strings only, and admits
non-negative safe integers only. Set-like arrays must already be UTF-8 byte
sorted and unique; the verifier rejects ambiguous input rather than silently
repairing it. Exact artifact bytes are hashed separately and may include a
presentation newline.

The source projection policy permits declared `.xinfa` and `.kungfu` authority
inputs but rejects Git internals, runtime/cache/index/generated state, private
raw payloads, and `.kungfu/project-cuts` protocol output. Paths are NFC POSIX
relative paths. This prevents a generated Project Cut from feeding its own
source root without broadly hiding user-declared authority material.

The repository-stable core API is [`index.mjs`](index.mjs):

```js
import {
  buildProjectCut,
  buildSourceProjection,
  createProjectCutReceipt,
  verifyProjectCut,
  verifyProjectCutReceipt,
  verifySourceProjection,
} from './framework/project-cut/index.mjs';
```

The canonical JSON and semantic-root implementation is shared from
[`../format/project-cut-canonical-json.mjs`](../format/project-cut-canonical-json.mjs)
and re-exported by this entrypoint. Project Cut continues to own the algorithm
label, admitted preimages and golden roots. Composition observation and
verification use the narrow repository-stable
[`composition.mjs`](composition.mjs) sub-entrypoint, which exports only
`compositionChanged`, `observeComposition`, and `verifyComposition`.
Settlement orchestration and source projection use the repository-stable
[`settlement.mjs`](settlement.mjs) sub-entrypoint, which exports only
`abandonSettlement`, `inspectSettlement`, `observeSettlementCommit`,
`prepareSettlement`, `reconcileCommit`, `sourceProjectionAtCommit`,
`sourceProjectionAtTree`, and `verifySettlement`. Settlement schemas and
implementation helpers remain private to `src/settlement.mjs`. Protected
settlement publication uses the repository-stable
[`publication.mjs`](publication.mjs) sub-entrypoint, which exports only
`advanceSettlementPublication`, `checkSettlementPublicationContract`,
`classifySettlementPublicationTrigger`, `inspectSettlementPublication`,
`materializeSettlementPublication`, `planSettlementPublication`,
`reconcileSettlementPublication`, and `verifySettlementPublication`.
Publication schema constants, contract-root helpers, status helpers, bounds,
and implementation details remain private to `src/publication.mjs`. The
remaining specialized `src/*` consumers stay compatibility-ratcheted; new
consumers cannot add another private import without changing the checked
boundary decision.

The object, composition, and settlement receipts retain their independent
payload schemas. Consumers that need a common evidence transport can wrap
those typed payloads with
[`kungfu.evidence-envelope/v1`](../evidence/schema/evidence-envelope-v1.schema.json)
through [`src/receipt-evidence.mjs`](src/receipt-evidence.mjs). The envelope
records `kind: receipt` and the exact payload schema in `type`; it does not
reinterpret a receipt as a witness, claim, or manifest. `observedAt` defaults
to `null` for deterministic protocol artifacts and may be supplied by an
observing caller.

Run the protocol and settlement contracts, golden roots, receipts, negative
fixtures, and a real Xinfa successor-Atlas integration:

```sh
./shifu check:project-cut-settlement
./shifu test:project-cut-settlement
./shifu test:project-cut-settlement:integration
./shifu check:project-cut-history
./shifu test:project-cut-history
./shifu check:source
```

The settlement CLI reads the Git index as the source candidate and defaults to
dry-run. Only `--execute` writes the Atlas promotion and content-addressed cut;
only `--stage` adds those exact paths to the index. It never commits or pushes:

```sh
./shifu project-cut prepare --request settlement-request.json --json
./shifu project-cut prepare --request settlement-request.json --execute --stage --json
./shifu project-cut verify --state .kungfu/runtime/project-cut/settlements/<cut>/state.json --json
./shifu project-cut commit-observe --state .kungfu/runtime/project-cut/settlements/<cut>/state.json --commit HEAD --execute --json
./shifu project-cut reconcile --commit HEAD --json
./shifu project-cut episode-seal --bundle episode-bundle.json --qualification episode-qualification.json --writer-id agent-a --json
./shifu project-cut episode-seal --bundle episode-bundle.json --qualification episode-qualification.json --writer-id agent-a --execute --stage --json
./shifu project-cut history-observe --request history-request.json --json
./shifu project-cut history-reconcile --observations history-observations.json --json
```

`--qualification` accepts either the direct
`kungfu.episode.qualification/v1` object or the complete JSON response from
`kungfu storage fsck --scope episode`. Execute mode retains its canonical public
preimage beside the sealed claims; raw runtime journals and payloads remain
excluded.

History requests declare the operation and semantic relation explicitly. A
rewrite or branch requires qualified prior observation objects; a merge
requires observations for its exact Git parents plus an admitted independent
Integration Episode. Reconciliation returns N:M Cut and Episode publication
maps and distinguishes superseded, archived, and orphaned bindings. It never
locks unrelated worktrees or mutates a ref.

The build-free Work History Selector is a separate read-only advisory
projection. It selects only rooted, source-referenced, temporally available
history from an exact index Cut, using the fixed gate order authority,
temporal, schema, source, supersession, invalidation, applicability, and
ranking. Its manifest binds the objective, Xinfa context, as-of time, index
Cut, policy, candidates, exclusions, gaps, and confidence. Stale indexes return
an incomplete zero-selection manifest; invalid roots or shapes are rejected
without a manifest. Private raw corpus and payload bodies are outside the input
schema, and the selector never writes Fact, Episode, Assignment, Work Control,
Git, or repository state.

```sh
./shifu check:work-history-selector
./shifu test:work-history-selector
```

The work-design preflight can compile Selector input directly from the installed
controller's verified global Work query. Only settled portable sealed-work
coordinates enter the candidate set; replicas are deduplicated by immutable
state root, partial global coverage remains explicit in the advice gaps, and a
caller-supplied candidate list is never treated as history evidence. The Shifu
route dispatches through checked-in Node protocol code without package install,
build output, or checkout-local cache writes. A rooted native policy
automatically adopts verified, bounded advice when history selection is
complete and non-empty, confidence is medium or high, and no gap other than
disclosed `global-work-partial` remains. Insufficient, low-confidence, or
otherwise unresolved advice returns `human-decision-required`; explicit human
dispositions and manual fallback remain exceptional paths rather than a default
approval gate:

```sh
kungfu workspace work --home --scope all --include-settled \
  --details components --json > global-work.json
./shifu work-design:preflight --input request.json \
  --history-query global-work.json
```

Work Design policy replay is a fourth, non-authoritative offline projection
over a caller-supplied exact qualified cohort. It compares immutable baseline
and candidate policy versions across selection, advice, disposition, outcome,
and coverage roots; reports classified drift and regression; and binds the
result to the declared `as_of`, cohort root, and policy roots. One qualified
sample is sufficient only for advisory replay. Default-policy promotion fails
closed below 30 qualified samples or when cohort, evidence, drift, regression,
or exact rollback checks fail.

Replay reports, candidate policies, and promotion artifacts grant no
Assignment, Work Control, repository, protected-branch, or active-default
authority. Even an eligible artifact records `activated: false`; activation
requires a separately authorized native decision outside this contract.

Settled portable Work can feed that replay path through a rooted outcome
compiler. The compiler attributes timeout only to active time outside declared
waits, counts rework only from acceptance reopen or corrective successor facts,
counts dependency correction only from post-admission graph-root changes, and
counts acceptance failure only from independent `unfit` assessments. Missing
legacy evidence remains `unknown`; it is never inferred from Git or elapsed wall
time. Shadow evaluation is exact per comparable cohort: fewer than 10 qualified
samples are observation-only, 10–29 are tentative, and 30 or more may satisfy
the default promotion floor.

Activation is a separate native, versioned state transition constrained by an
exact parameter envelope and expected-state root. An eligible candidate enters
canary automatically only inside that envelope; semantic expansion returns
`human-decision-required`. Canary and promoted-policy monitoring can restore the
exact previous policy root automatically when the declared regression threshold
is crossed. The build-free status operation is a read-only projection and owns
no Work Control, repository, objective, scope, acceptance, or safety authority.

```sh
./shifu check:work-design-policy-replay
./shifu test:work-design-policy-replay
./shifu work-design:feedback compile --input outcome-request.json
./shifu work-design:feedback shadow --input shadow-request.json
./shifu work-design:feedback status --input status-request.json
```

Merge-safe composition is a third, separate rooted layer described by
[KF-ADR-019f86da-4f90-7b77-a360-0725f23aad30](../../docs/adr/KF-ADR-019f86da-4f90-7b77-a360-0725f23aad30.md).
It discovers the publication commit for every Cut changed between an exact
base and candidate, verifies that Cut at its own source snapshot, and binds the
N:M mapping into `project.cut.composition/v1`. The output root describes the
candidate source projection; it does not reinterpret an input Cut or place a
Git object id in `project.cut/v1`.

```sh
./shifu project-cut composition-observe --base <base-ref> --commit <candidate-ref> --json
./shifu project-cut composition-verify --receipt composition-receipt.json --json
./shifu check:project-cut-composition
./shifu test:project-cut-composition
```

Source Acceptance invokes the same scoped composition gate. No changed Cut is
a scoped no-op, not a global-DAG pass. Changed manifests, receipts, and sealed
Episode evidence enter the scope. The gate fails closed on an absent semantic
parent or receipt, active or unanchored source drift at publication, ambiguous
overlapping deltas, or a successor that does not bind the exact parents,
admitted Integration Episode, and output projection. When a merge queue
linearizes several iterative Cuts from one PR, an exact same-project active
successor may anchor the superseded ancestors; the receipt retains each bounded
replay mismatch as a `superseded-publication-replay` omission instead of
silently treating historical Git coordinates as semantic authority. Historical
global reconciliation remains available separately and may still report
orphaned or superseded observations outside the candidate scope.

Removing a complete Cut bundle (both manifest and receipt) retires that Cut
from the candidate and is a scoped no-op. Removing only one side, or removing
Episode evidence still referenced by a surviving Cut, remains fail-closed.

Before queue entry, the repository-internal admission tool recreates the
rebase-style candidate as unreachable Git objects without changing refs, the
index, or the worktree. It applies the PR's first-parent commits to the current
base, then runs the same scoped composition gate against that candidate. Merge
conflicts and protocol diagnostics such as `source-drift` are machine-classified
as non-retryable `repair-required` results, so a deterministic failure can be
repaired before it consumes a merge-group validation cycle. Tooling failures
remain distinct `indeterminate` results and fail closed. Source Acceptance owns
the tool's contract tests; the external merge orchestrator owns invocation.

“Admitted” uses the Episode provider's canonical evidence verifier, including
manifest/claims schemas, provider algorithm, canonical bytes, typed-fsck
qualification policy, Episode identity, lifecycle, and export capability. A
self-consistent forged provider root does not satisfy composition admission.

`hooks/project-cut-hook.mjs` is an optional thin adapter. Point
`PROJECT_CUT_SETTLEMENT_STATE` at local rebuildable state and invoke it with
`pre-commit` or `post-commit`; it only calls the same public verify/observe
core, performs no compile or network access, and explicitly reports
`authority: false`. Skipped or absent hooks do not create proof: `reconcile`
is the stage-0, headless recovery path from tracked Git JSON/JSONL.

Optional JSON Schema validation runs when repository dependencies are present;
the semantic/root verifier and settlement core use only Node built-ins and
remain available for stage-0 recovery.

## Protected settlement publication

[`publication.contract.json`](publication.contract.json) defines the bounded
Git projection of already sealed Episode shadows and settled Project Cuts. A
declared Wave or batch produces one content-addressed batch root, one
`machine-ledger/settlement/<root>` source branch identity, and one pull-request
marker. The protected target is never pushed directly. Duplicate and concurrent
observations reconcile through the same batch identity; changing any selected
root produces a distinct successor batch instead of rewriting history.

The versioned no-recursion rule rejects events already marked by the generated
branch prefix, `kungfu-machine-ledger` label, generator identity, or publication
root. Only canonical Episode claims/manifests/qualifications, Project Cut
manifests/receipts, and their content-addressed batch manifest enter Git. Raw
journals, private payloads, credentials, signed URLs, caches, locks, and large
artifacts are not planner inputs.

Publication state is a rebuildable runtime projection. It exposes lag,
unpublished Cut count, branch and pull-request coordinates, retry count, and the
latest exact failure root. A publication failure never blocks continuation from
the settled native Fact Cut and never becomes Work Control completion authority.

```sh
./shifu project-cut publication-prepare --request publication-request.json --json
./shifu project-cut publication-prepare --request publication-request.json --execute --stage --json
./shifu project-cut publication-inspect --plan publication-plan.json --json
./shifu project-cut publication-reconcile --plan publication-plan.json --observation pr-observation.json --json
./shifu project-cut publication-verify --batch-root sha256:... --commit HEAD --json
./shifu check:project-cut-publication
./shifu test:project-cut-publication
```

## Native delivery-loop qualification

[`native-loop-qualification.contract.json`](native-loop-qualification.contract.json)
composes the delivered post-merge evidence adapter and protected settlement
publication interfaces into one exact, machine-verifiable success predicate.
It does not replace either authority. The real-path manifest must bind the
Assignment request, protected source PR and merge-group evidence, native Fact
and Episode, settled Project Cut, protected ledger PR, deterministic fault
receipts, and fresh-clone continuation readback.

The verifier fails closed on absent or inexact coordinates and proves the
protected ledger from Git without the original runtime cache. Its history rule
is intentionally asymmetric: fewer than 30 samples blocks default-policy
promotion only; advisory-mode qualification remains eligible.

```sh
./shifu project-cut native-loop-contract-check --json
./shifu project-cut native-loop-seal --input qualification-input.json --json
./shifu project-cut native-loop-verify --manifest qualification.json --json
./shifu check:native-loop-qualification
./shifu test:native-loop-qualification
```
