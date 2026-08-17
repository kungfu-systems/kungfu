---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-08
theme: domain-product-adopter
doc_type: repository-document
sources: [local-files, executable-probe, official-upstream]
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-17
ai_provenance: GPT-5 via Codex on 2026-08-17; based on visible package contracts and executable clean-room tests, with no claim about invisible model context or external adoption
---

# Domain-product adopter template

This fixture is an independent, non-commercial product-shaped consumer. It
uses the package-visible Kungfu Core primitive authority, the published KFD
product-runtime category, and Buildchain's protocol-neutral delivery gate.

The product owns its identity, source and package cut, domain mapping, runtime
receipt, rejected-fault receipt, recovery receipt, and release readback. KFD
owns category semantics; Buildchain carries the result. A passing result grants
no runtime permission, release authorization, or independent certification.

Run the reproducible clean-room qualification through Shifu:

```sh
./shifu test:domain-product-adopter
```

The test copies only package-visible files into an empty temporary project,
sets an empty temporary Home, and resolves all three dependencies from that
project's `node_modules`. It rejects copied Kungfu roots, undeclared primitive
use, omitted runtime-fault evidence, and substituted recovery evidence.
