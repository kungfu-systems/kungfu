---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0114
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1071]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1071
qualification_refs: [.xinfa/project.json, crates/xinfa/src/semantic_project.rs, scripts/shifu-documentation-surfaces.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-18
theme: xinfa-native-semantic-project-authority
confidence: high
evidence_grade: A
last_reviewed: 2026-07-18
---

# ADR-0114: Xinfa owns semantic project materialization

- Status: accepted; implementation implemented
- Date: 2026-07-18
- Category: context compiler / documentation control plane
- Related: [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md), [ADR-0093](ADR-0093-xinfa-dual-first-verified-context-contract.md), and [ADR-0110](ADR-0110-structured-go-route-resolution.md)

## Decision

The project owns discovery, classification, binding, route intent, and compatibility declarations in `.xinfa/project.json`. Xinfa owns the deterministic conversion of an exact inventory into `xinfa.project/v1`, including node and edge construction, provider revision, route selection, parity validation through the project compiler, and project roots.

Shifu is a thin host adapter. It may enumerate tracked files, reject unsafe paths, read exact bytes, and submit the resulting inventory through the public `xinfa project materialize` command. Its inventory may carry a claimed exact-inventory root for transport integrity, but it carries no semantic node identity: Xinfa derives every node and independently recomputes the inventory root before using it. A node injection or root mismatch fails closed. Shifu must not independently construct a Xinfa graph or calculate a semantic project root.

The former `shifu.documentation.surfaces.json` surface remains only as an explicit compatibility alias. The previous small dogfood project is retained separately as `.xinfa/dogfood-project.json` so standalone qualification does not compete with the repository semantic declaration.

## Authority map

| Concern | Authority |
| --- | --- |
| Discovery and declarations | Project (`.xinfa/project.json`) |
| Exact repository file inventory | Shifu adapter |
| Nodes, edges, provider and route node sets | Xinfa |
| Canonicalization, validation and roots | Xinfa |
| Gates and product qualification | Shifu |

## Compatibility and falsification

The migration is invalid if Shifu submits node identities, if Xinfa accepts a mismatched inventory root, if Shifu regains graph-building logic, if the compatibility alias contains independent declarations, or if standalone/direct/Shifu Atlas roots diverge. The retained compatibility oracle compares the semantic result after Xinfa-native node derivation; exact-inventory transport fields are not themselves semantic authority.
