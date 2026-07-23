# Agent-first Profile authoring

An installed Kungfu product can author and operate a KFX Profile Suite without
a Kungfu source checkout or product rebuild. The Profile is a portable source
closure; Core remains the lifecycle and journal authority.

## Discover before generating

```sh
kungfu profile capabilities --json
kungfu profile examples --json
```

The capability response contains the exact embedded KFX Profile schema,
current lifecycle contract, supported operations, decision-card version, and
the optional custom-member build command. Generated Profile files cannot
declare their own root, trust, qualification, admission, or authorization.

## Scaffold and validate

Create a `kungfu.profile-brief/v1` document from the user's description. The
brief must explicitly settle identity authority, evidence strength, and
migration mode. If a load-bearing choice is absent, scaffold returns open
`kungfu.decision-card/v1` records and writes nothing.

```sh
kungfu profile scaffold brief.json --out ./my-profile --json
kungfu profile scaffold brief.json --out ./my-profile --execute --json
kungfu profile validate ./my-profile --json
kungfu profile qualify ./my-profile --json
```

The first scaffold command is a deterministic source plan. The second writes
that exact plan to an empty destination. Validation reads the Suite manifest,
resolves every member package exactly once, computes roots from package bytes,
then delegates full Profile closure verification to Core. Qualification only
claims the checks this release implements: source contract, content closure,
and runtime contract.

## Plan, decide, and apply

Runtime mutation cannot start from the source document alone:

```sh
kungfu profile plan install ./my-profile --out install-plan.json --json
kungfu profile decide install-plan.json --choice approve \
  --authorized-by workspace-owner --out install-answer.json --json
kungfu profile apply install-plan.json \
  --authorization-file install-answer.json --json
```

The answer binds the exact decision card, Core plan id, basis root/revision,
effects, and claimed actor. It is not a cryptographic identity proof; external
workspace policy remains responsible for deciding whether the actor has the
declared authority. Apply recomputes the Core plan and rejects stale source,
member, permission, current-root, revision, or runtime facts.

Use `qualify` and `activate` as distinct lifecycle actions. Activation grants
only permissions declared by the Profile closure. `list`, `inspect`, and
`history` are projections over the Core journal fold.

## Diff and actions

```sh
kungfu profile diff ./old-profile ./new-profile --json
kungfu profile actions ./my-profile --json
kungfu profile invoke ./my-profile <action-id> --json
```

Diff classifies display, content, permission, authority, evidence, and
migration changes. Load-bearing categories include decision cards. Action
planning binds the exact active Profile root and revision and checks granted
capabilities. A declared custom KFX member cannot bypass its runtime
confinement or replace the Core fact, query, assessment, lifecycle, or journal
authority.

Optional code members build inside their own KFX package:

```sh
kungfu sdk kfx build
```

That command uses the installed SDK and does not patch or relink Kungfu. The
desktop product carries the SDK, templates, KFD material, JavaScript bundler,
and matching native bundler package required by this command.

## Materialize facts, query a view, and assess a claim

Profile declarations do not become workspace fact authority during install or
activation. Materialization is a separate approved operation:

```sh
kungfu profile contract-plan ./my-profile --out contract-plan.json --json
kungfu profile decide contract-plan.json --choice approve \
  --authorized-by workspace-owner --out contract-answer.json --json
kungfu profile contract-apply contract-plan.json \
  --authorization-file contract-answer.json --json
```

The resulting fact types use the existing KFD-1 declaration and admission
runtime. Profile views use ADR-0048 QueryDefinitions and receipts rather than a
second query engine. A member-resolved query family supplies its bindings and
definition explicitly:

```sh
kungfu profile query-plan ./my-profile <view-id> \
  --resolution-file query-resolution.json --out query-plan.json --json
kungfu profile query-run ./my-profile query-plan.json --json
```

KFD-2 assessment binds one declared claim type, a runtime claim-instance id, a
purpose-compatible policy, the exact query proof, and a verified work Episode.
Policies that require an independent observation keep that evidence explicit:

```sh
kungfu profile assess-plan ./my-profile query-receipt.json \
  --claim-id <claim-type-id> --claim-instance-id <runtime-claim-id> \
  --policy-id <policy-id> --purpose <purpose> \
  --work-episode-id <episode-id> \
  --independent-observation-file observation.json \
  --out assessment-plan.json --json
```

The operator must still answer the assessment decision card and run the exact
approved plan. A Profile can require stronger evidence; it cannot make Core
accept missing query proof, canonical facts, Episode closure, or independent
observation.

## Export and transfer Profile material

Profile source and admitted evidence remain separate authorities. Export the
source closure with:

```sh
kungfu profile export ./my-profile --out profile.full.json --json
kungfu profile export ./my-profile --out profile.thin.json --thin --json
```

A full bundle includes exact source bytes. A thin bundle contains the Suite
and member roots plus a file inventory, so it is useful for comparison and
audit but cannot reconstruct missing bytes. Import is plan-first, requires an
empty destination and explicit actor, and reconstructs source only:

```sh
kungfu profile import profile.full.json --out ./restored-profile --json
kungfu profile import profile.full.json --out ./restored-profile \
  --execute --authorized-by workspace-owner --json
```

Import does not install, qualify, activate, grant permissions, admit facts, or
assert trust. Move KFD-1 evidence separately with `kungfu facts export` and
`kungfu facts import`; those bundles preserve Episode, schema, payload, and
proof roots without activating a Profile.

## Product status and supported claim

The installed macOS ARM64 product has qualified an agent-authored
Week/Day/Action Suite outside the Kungfu checkout. The qualification covered an
optional member build, lifecycle, separately approved contract materialization,
three admitted fact surfaces, a member-resolved query, a purpose-bound KFD-2
assessment, coexistence with Mission Control, upgrade/rollback/removal/reinstall,
and full/thin source and evidence portability.

Mission/Go is therefore a first-party Profile, not the required vocabulary for
all users. The GUI Profile Manager discovers lifecycle and source health from
the same public catalog and receipts used by Agents. This is still a pre-release
surface: it is not a no-code Profile builder, marketplace, remote registry, or
cryptographic identity provider. See [Known Limits](../qualification/known-limits.md) for the
remaining qualification boundary.
