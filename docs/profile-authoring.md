---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: public-document
review_state: self-reviewed
sensitivity: public
---

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
capabilities. S2 executes only the common Profile lifecycle runner; a declared
custom KFX member cannot bypass its runtime confinement, and domain fact/query/
assessment bindings arrive with the generic composition stage.

Optional code members build inside their own KFX package:

```sh
kungfu sdk kfx build
```

That command uses the installed SDK and does not patch or relink Kungfu. The
Profile Manager GUI, generic renderer, Mission Control migration, marketplace,
and independent Week/Day product qualification are not part of this stage.
