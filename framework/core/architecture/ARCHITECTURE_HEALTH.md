---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-06-01/2026-07-15
theme: kungfu-core-architecture-health
doc_type: generated-health-report
sources: [local-files]
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-15
---

# Core Architecture Health

Generated from the architecture authority and repository facts. Metrics are structural signals, not individual performance measures. Affected-native timing comes from retained qualification evidence; binary size remains release-owned because PR source authority has no stable packaged artifact.

Authority root: `sha256:c1bd00590405406c09ebff76609d645ba0cb3c144cbdc608df2fbbc97b7247c5`

| Metric | Current | Baseline | Budget | Policy |
| --- | ---: | ---: | ---: | --- |
| `component_cycles` | 0 | 0 | 0 | blocking |
| `maximum_component_fanout` | 11 | 11 | 11 | blocking |
| `maximum_public_header_propagation` | 12 | 12 | 12 | blocking |
| `maximum_responsibility_utilization_percent` | 93 | 93 | 100 | blocking |
| `maximum_component_churn` | 319 | 319 | 319 | advisory: Historical coupling is diagnostic; ordinary development must not be blocked by commit volume alone. |
| `affected_native_duration_ms` | 610610 | 610610 | 1200000 | blocking |
| `binary_size_bytes` | unknown | unknown | advisory | advisory: PR source authority has no stable packaged artifact; release qualification retains binary-size evidence. |
| `external_dependency_closure` | 8 | 8 | 12 | blocking |

Observations: none.
