---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0003
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/755]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/755
qualification_refs: [scripts/shifu-uv-cache-adapter.test.mjs, scripts/shifu-cache-runtime.test.mjs, scripts/check-shifu-cache-contract.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus, official-upstream]
period: ongoing
theme: shifu-uv-effective-lock
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# SHIFU-ADR-0003: uv cache enforcement uses a disposable effective lock

- Status: accepted; implemented and qualified
- Date: 2026-07-13
- Scope: Shifu strict cache execution for uv-managed Python projects
- Related: [SHIFU-ADR-0001](./SHIFU-ADR-0001-cache-profile-contract-and-ownership.md)

## Context

An environment binding such as `UV_DEFAULT_INDEX` controls package discovery,
but a frozen `uv.lock` also records exact registry and artifact URLs. A build can
therefore receive the selected central index and still fetch locked artifacts
from a public host. Rewriting the tracked lock in place would leak private
topology into a public repository, make the checkout dirty, and couple one
developer's transport path to every other consumer.

The committed lock remains a public reproducibility artifact. Strict
self-hosted execution still needs a fail-closed guarantee that every registry
and registry artifact request uses the profile-selected endpoint.

## Decision

Tracked `uv.lock` files in the Kungfu repository contain only official PyPI
transport URLs: `https://pypi.org/simple` for registry sources and
`https://files.pythonhosted.org` for registry artifacts. A source gate checks
every tracked lock and rejects private, local, alternate, or malformed hosts.

When a profile selects a Python index, Shifu performs these steps before
starting the requested build task:

1. Mirror each tracked uv project into a process-private temporary directory,
   copying only `pyproject.toml` and `uv.lock` and linking the remaining source
   tree without writing it.
2. Ask the pinned `uv` executable to refresh the copied lock against the
   selected endpoint.
3. Normalize transport-only fields and require the effective lock's dependency
   semantic digest to equal the canonical lock's digest.
4. Require every effective registry and artifact URL origin to equal the
   selected endpoint origin.
5. Put a child-only `uv` wrapper first on `PATH`. Project commands use the
   mirrored project, a disposable `UV_PROJECT_ENVIRONMENT`, and frozen mode.
6. Remove the overlay after the child exits and emit only digests, counts,
   verification state, and cleanup state in the resolution receipt.

`uv add`, `uv remove`, and `uv version` are rejected inside a cache-managed
execution because mutations belong in the canonical development checkout.
Non-project uv commands continue to reach the real executable. Profiles that
allow fallback attempt the same effective-lock overlay. If tool-native
rebinding fails, Shifu records the declared fallback and continues with the
canonical public lock. Required profiles never take that path. A generic HTTP
probe is diagnostic evidence only; tool-native rebind is the execution gate.

## Compatibility

The input profile schema does not gain a second uv-specific policy language.
The existing `UV_DEFAULT_INDEX` binding plus strict profile policy selects this
behavior. The resolution schema gains an optional `toolEvidence` object; this
is an additive v1-compatible receipt extension. Unknown fields remain rejected.

Buildchain still passes only the profile reference and digest. It does not
interpret lock contents, mirror URLs, or uv arguments. The inventory controller
continues to own the concrete endpoint projected into the profile.

## Consequences

- Public source history and generated artifacts do not expose private network
  addresses.
- Strict runner builds cannot silently escape to PyPI when the central endpoint
  is unavailable or incomplete.
- Canonical locks and the checkout remain byte-identical and Git-clean.
- The disposable Python environment may cost more than reusing a project-local
  `.venv`; that isolation is intentional because URL-keyed uv cache entries are
  not portable between the central and public lock identities.
- Direct URL dependencies whose origin differs from the selected endpoint fail
  strict validation until the cache profile and provider can represent them.

## Alternatives considered

- **Environment override only** — rejected because frozen artifact URLs remain
  authoritative.
- **Rewrite the tracked lock in place and restore it later** — rejected because
  crashes can leave a dirty checkout and private coordinates can enter commits.
- **Prewarm through a central lock, then install the public lock offline** —
  rejected because uv cache keys include the artifact URL identity; a central
  fetch does not prove the public URL-keyed lock is available offline.
- **Teach Buildchain uv fields** — rejected because Buildchain owns process and
  Shifu owns execution semantics.
