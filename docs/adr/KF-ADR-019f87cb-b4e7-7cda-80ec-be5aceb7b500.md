---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f87cb-b4e7-7cda-80ec-be5aceb7b500
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1393]
qualification_refs: [framework/core/architecture/layered-api-encoding-boundary.contract.json, framework/action/action-canonical-json-v1.json, framework/core/src/python/kungfu/canonical_json.py, framework/core/src/libkungfu/src/runtime/action/action_canonical_json.cpp, framework/core/src/libkungfu/include/kungfu/runtime/storage/json_edge.h, scripts/check-layered-api-encoding-boundary.test.mjs, scripts/check-canonical-json.test.mjs, framework/core/src/libkungfu/include/kungfu/api.h, framework/core/src/libkungfu/tests/api_contract_tests.cpp, framework/core/tests/python/test_canonical_json.py, framework/core/tests/python/test_fact_kernel_integrity.py, tests/qualification/layers/sdk/wire-fixture-v1.json, tests/fixtures/canonical-json/vectors.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: layered-api-and-protocol-owned-canonical-encoding
confidence: high
evidence_grade: B
last_reviewed: 2026-07-24
ai_provenance: GPT-5 via Cursor on 2026-07-21; based on repository contracts, ADRs, implementations, and user-authorized design constraints; no claim about unobserved third-party builders or unreleased artifacts
---

# KF-ADR-019f87cb-b4e7-7cda-80ec-be5aceb7b500: Layered APIs share one C ABI waist and each identity protocol owns its canonical bytes

- Status: accepted; additive implementation staged
- Date: 2026-07-21
- Category: public API layering / canonical identity / carrier encoding
- Related: [KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3](KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3.md),
  [KF-ADR-019f86da-4f90-7650-bb2d-932dce8ae16a](KF-ADR-019f86da-4f90-7650-bb2d-932dce8ae16a.md),
  [KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be](KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be.md),
  [KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb](KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb.md),
  [KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367](KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367.md), and
  [KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md)

## Context

Kungfu already has the intended hourglass waist: `kungfu_get_api`, caller-sized
C tables, fixed-width values, explicit protocol/schema/encoding metadata, and
bounded byte views. The standard ABI exposes discovery, stream, ledger-action,
and maintenance. The native Action Geometry and Domain Profile implementation
also exists, but remains reachable through an internal storage JSON edge rather
than a responsibility-scoped public interface. Python and Rust SDKs use the
standard ABI; the shipped Node storage SDK still uses its older in-process C++
adapter.

The phrase “canonical JSON is the identity currency” is too broad for the
implemented system:

- Fact Root v2 uses the closed typed KFR2 binary preimage from KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367.
- Episode content identity uses a versioned chain over selected typed POD field
  bytes, not JSON.
- Action Geometry/Profile documents, Project Cut, Xinfa, and several receipts
  use their named JSON canonicalization protocol. The current ActionBinding
  root is only an implementation-local compatibility identity: it hashes the
  current C++ compact, object-key-ordered rendering and does not yet claim
  portable canonical equivalence.
- content-addressed bodies commit to exact opaque bytes. Such a body can happen
  to contain FlatBuffers, but that hash proves artifact-byte identity, not
  logical equivalence between independently built FlatBuffers values.

Treating JSON, FlatBuffers, C layout, or an ABI table as the universal identity
codec would silently reinterpret existing Roots. Treating every journal payload
as FlatBuffers would also contradict KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3: closed kernel records remain Hana
POD while open/domain records use one `.fbs` owner.

## Decision

### 1. One public ABI waist, independently versioned responsibility interfaces

`kungfu_get_api` remains the only exported bootstrap and binding root. C++,
Node, Python, and Rust consumers negotiate responsibility-scoped interfaces and
exchange this wire envelope:

```text
interface id/version
protocol id/version
schema reference
encoding
exact request bytes
  ->
response protocol/version/schema/encoding
exact response bytes + lifetime token
```

The ABI transports bytes and metadata. It does not infer authority or define
the bytes’ semantic identity. New responsibilities use additive interfaces;
existing v1 table layouts and operation numbers do not change.

The first additive slice publishes `runtime-action` v1 over the existing
`libkungfu/runtime/action` authority. Its first wire encoding is the explicit
JSON edge `kungfu.action-runtime.operation/v1`. It does not move Action Geometry
or Domain Profile semantics into bindings.

Profile contracts remain a separately deployed authority registry rather than
being copied into every language package. A consumer configures that registry
through `KUNGFU_CONTRACT_REGISTRY` or the operation's explicit `search_base`;
SDK package location and process working directory are not semantic inputs.

### 2. Every identity protocol owns one canonical preimage

There is no universal Root codec. A Root, receipt, contract, or evidence object
must name or inherit a versioned protocol that defines:

- selected fields and absent/default rules;
- scalar representation and Unicode rules;
- ordering and framing;
- domain separation and hash algorithm;
- compatibility, successor, and rejection behavior.

Current protocol classes include:

| Class | Canonical preimage | Examples |
| --- | --- | --- |
| closed typed binary | protocol-defined tags and framing | KFR2 Fact Roots |
| typed POD field chain | selected field bytes and versioned link framing | Episode content Root |
| protocol-owned canonical JSON | decoded values with a named JSON dialect and vectors | Action Geometry/Profile, Project Cut, Xinfa |
| implementation-local JSON | current implementation rendering only; no cross-implementation equivalence claim | ActionBinding v1 |
| exact opaque bytes | byte-for-byte artifact content | content store bodies, schemas, WASM, foreign documents |

JSON participates in identity only when the named protocol says it does.
`application/json` on an ABI message is otherwise an edge encoding, not a Root
claim.

### 3. Schema owner, carrier bytes, and semantic identity are separate axes

Persisted structured facts retain KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3’s one-owner rule:

- closed kernel records: Hana POD;
- open and evolving domain records: FlatBuffers;
- opaque bodies: exact content bytes with integrity metadata.

FlatBuffers builder output is a valid carrier and can be an exact opaque
artifact. It does not automatically become a portable semantic preimage:
logically equal tables built with different field-write order, vtable sharing,
padding, or implementation choices need not have equal buffers. A protocol that
needs logical identity over a FlatBuffers-owned value must define a canonical
projection or a separately qualified canonical binary protocol.

Therefore:

- no current semantic Root may be redefined as “SHA-256 of whatever builder
  emitted”;
- hashing an exact FlatBuffers artifact for content-store integrity remains
  allowed and is explicitly not a logical-equivalence claim;
- introducing direct FlatBuffers semantic identity requires a successor
  protocol, independent implementations, exact positive/negative vectors, and
  preserved legacy readers.

### 4. Layer policy

- **L0 reality kernel:** strongest compatibility; Fact/Episode identity remains
  with its existing KFR2, POD-chain, content, and journal protocols.
- **L1 responsibility geometry and Domain Profiles:** public
  `runtime-action` messages use the named JSON edge; common typed SDK methods are
  generated from one machine contract and contain no authority or policy
  branches.
- **L2 coordination loop:** semantic begin/settle requests, receipts, and state
  commitments use their named protocols; future journal-resident events must
  select Hana or one `.fbs` owner. This ADR records the constraint but does not
  move the loop into native code.
- **Xinfa / Project Cut side plane:** remains inspectable, content-addressed JSON
  evidence. FlatBuffers is not added to Xinfa’s authoritative dependency or
  Root path.

### 5. Generated SDKs preserve the wire receipt

Generated typed methods are projections of the machine contract. They may
construct typed requests and parse typed results, but must also expose the exact
response metadata and bytes returned by the C ABI. Bindings may not parse and
re-serialize a response before conformance comparison. Because
`application/json` is an edge encoding here, generated projections validate the
decoded schema and values rather than requiring one object-key order or
whitespace rendering.

The first pilot covers bounded read-only L1 operations. C++, Node, Python, and
Rust run frozen response-byte vectors rather than selecting one adapter as a
dynamic oracle. The gate compares exact metadata and bytes, measures the runtime
directory before and after each case, and runs shared malformed-envelope cases
through each generated projection. Reordered-key and whitespace variants are
also required positive cases. This proves wrapper and projection parity over the
one native protocol authority; it does not claim four independent serializers.

## Compatibility and migration

This decision is additive:

- no existing Root preimage, receipt bytes, journal layout, schema owner, ABI
  table prefix, operation number, or public symbol changes;
- `KF_ABI_V1` and the four existing v1 interfaces remain valid;
- Python and Rust negotiate the additive runtime-action interface lazily, so a
  consumer using only the four existing interfaces remains compatible with an
  older ABI-v1 runtime;
- the current Node internal storage adapter remains compatibility-only while a
  new standard-ABI wire path is added;
- on Windows the Node addon links the ABI bootstrap object into the addon's
  existing static runtime image; it must not load a second `kungfu.dll` runtime
  beside the legacy adapter;
- `kungfu-sdk` is extended for Rust; no parallel Rust authority crate is added;
- L2 native migration and full typed-SDK coverage remain separate work.

## Falsification and gates

The implementation is unacceptable if any of these passes:

- one contract claims JSON, FlatBuffers, C layout, or backend bytes are the
  universal Root preimage;
- KFR2 or Episode identity is reserialized as JSON;
- logically equal FlatBuffers values are assumed to have equal builder bytes
  without a separately qualified protocol;
- a generated binding calls a private semantic function instead of the standard
  ABI and still claims wire parity;
- a binding discards or reserializes the raw response before byte comparison;
- generated operation/protocol/schema/version constants drift from the machine
  contract;
- Xinfa gains a FlatBuffers dependency or an authoritative binary cache without
  a successor decision;
- an existing ABI consumer, Root vector, receipt vector, or journal fixture
  changes.

The source gate checks the encoding taxonomy, existing protocol authorities,
ABI/header projection, generated outputs, Xinfa direct and transitive dependency
boundary, and frozen vectors. The affected-native pull-request workflow builds
installed artifacts and runs the complete four-language wire qualification on
Linux; platform release claims still require the ordinary Darwin/Linux/Windows
qualification matrix.

## Consequences and residual risk

Consumers gain one low-level escape hatch for every published responsibility
and generated conveniences for common operations without a second semantic
owner. Protocol evolution remains explicit instead of being hidden in a JSON
library or FlatBuffers builder.

The first pilot does not prove every future L1/L2 schema is generated, that
external adoption exists, or that FlatBuffers can never define a canonical
protocol. It proves only the declared interfaces and vectors. New protocols,
builders, platforms, and release artifacts need their own evidence.
