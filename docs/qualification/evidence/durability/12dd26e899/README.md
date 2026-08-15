---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-13
theme: kungfu-durability-qualification
doc_type: qualification-evidence-index
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-13
sources: [executable-probe, local-files]
---

# Three-platform durability process evidence at `12dd26e899`

This directory retains the six local process-crash qualification reports for
Kungfu source revision
`12dd26e8992b012067d0fd54da42d17ae93a68a2` and tree
`a41d11a7354b827ec0acbd911381219a7e98e726`.

| Platform profile | Filesystem | Durability profiles | Result |
|---|---|---|---|
| `macos-apfs-process-v1` | APFS | `durable_group`, `durable_sync` | passed |
| `linux-ext4-process-v1` | ext4 | `durable_group`, `durable_sync` | passed |
| `windows-ntfs-process-v1` | NTFS | `durable_group`, `durable_sync` | passed |

Each report was produced on the named host by the repository-local
`shifu durability:qualify` command after `shifu build:core` succeeded. The
temporary execution environment removed the Atlas controller-cache bindings
and selected an empty `XDG_CONFIG_HOME`, allowing the same Shifu command to
reuse the host's existing Conan cache without changing persistent
configuration. No GitHub workflow or self-hosted runner dispatch produced
these reports.

Every report records a clean source tree, four passing suites, zero missing
markers, its Shifu doctor record, and SHA-256 for each adjacent raw log. The
retention step rechecked all raw-log hashes against their report before adding
them here. Windows dry-run reports had already occupied the shorter planned
paths, so its immutable executed reports retain the `-executed` suffix.

## Claim boundary

These reports qualify only the declared `process-crash-proxy` envelope. All
six deliberately retain:

- `declared_process_envelope_qualified=true`;
- `power_loss_qualified=false`;
- `production_profile_eligible=false`.

They do not prove sudden power loss, device or controller-cache persistence,
real ENOSPC, physical I/O failure, production profile activation, or the
complete `Single-Host Institutional Profile v1`. Those claims require
separate disposable VM/device, host-restart, backup/restore, and load evidence.
