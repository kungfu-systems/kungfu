---
status: draft
period: ongoing
theme: shifu-cache-profiles
doc_type: design-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-12
---

# Shifu cache profiles

A cache profile is a generated, secret-free instruction set for one principal,
host class, and execution scope. It is an instance of the
[profile schema](schema/cache-profile-v1.schema.json); this document does not
repeat the schema fields.

## One contract, multiple projections

```text
private inventory
      |
      | generate + validate against Shifu schema
      v
principal/host profile
      |
      | approved projection
      v
local development config or trusted runner input
      |
      | Shifu resolves bindings and records a redacted receipt
      v
task execution
```

The inventory controller owns endpoint availability, topology, and assignment.
Shifu owns the profile and resolution contracts. A host consumes a projection;
it does not become a second authority. Buildchain may select the runner and pass
a trusted profile reference, but it does not reinterpret profile fields.

## Development and runner policy

The examples show two policy shapes without prescribing private infrastructure:

- [`development.cache-profile.json`](examples/development.cache-profile.json)
  prefers caches and allows declared upstream fallback.
- [`self-hosted-runner.cache-profile.json`](examples/self-hosted-runner.cache-profile.json)
  requires selected caches and fails before expensive work when they are
  unavailable.
- [`cache-resolution.json`](examples/cache-resolution.json) shows the redacted
  receipt shape.

The schema, not these examples, decides validity. Examples use the reserved
`.invalid` domain and contain no live service coordinates.

## Security and trust

Profiles never carry credential values. Authentication remains in the
tool/provider's approved secret surface, while the profile may only select
non-secret bindings. HTTP endpoints reject user information, query strings, and
fragments so a token cannot be smuggled into the URL. Resolution evidence uses
the redaction rule declared by the contract and hashes local paths instead of
publishing them.

Mirrors accelerate transport; they do not replace upstream integrity. Each
service declares the applicable verification method. A `none` declaration must
carry a rationale and is visible in review.

## Compatibility

Compatibility is defined once in
[`cache-contract.json`](cache-contract.json). Consumers identify the contract by
its `schema` value and major version, reject unknown fields, and fail closed on
an unsupported major version. New mandatory fields or changed meanings require
a new major schema rather than silent reinterpretation. Resolution evidence
binds the SHA-256 of the exact source profile bytes, avoiding an implicit second
canonical JSON renderer.

## Local-development consumption before publication

An inventory controller can pin a local Kungfu checkout or a locally built
Shifu binary, obtain the schema through `shifu cache schema profile`, validate
the generated instance, and project it to an approved local configuration
surface. This makes dogfood independent of npm/alpha publication while keeping
the exact Shifu source revision auditable.

The current slice establishes discovery, schema, examples, and repository
conformance. Automatic profile application and provider-specific config writers
are follow-up execution work; until they exist, existing `build-local.env`
bindings remain the compatible consumption edge.
