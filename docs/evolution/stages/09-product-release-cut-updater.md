# Stage 9: Product Release Cut and Updater Convergence

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "product-release-cut-updater-convergence",
  "era": "work-control-dogfood",
  "sequence": 9,
  "title": "Product Release Cut and updater convergence",
  "status": "open",
  "evolutionImpact": "opens",
  "period": { "start": "2026-07-29", "end": "ongoing" },
  "buildsOn": ["native-work-control-recursive-dogfood"],
  "pressure": "Release channels, immutable images, KFD-3 local artifacts, and Shifu promotion existed, but SemVer and per-artifact roots did not identify one exact product world or authorize movement between same-label builds.",
  "priorLimitation": "Shifu could select local desktop builds while native archive installation and rollback used separate coordinates; same-SemVer descendants and public supersession had no shared exact identity.",
  "localCapability": "Product Release Cut and Cut Transition bind exact public and local release worlds, KFD-3 registers desktop plus CLI plus final manifest in one slot, and Shifu delegates installation and rollback to the native updater.",
  "compression": "Version label, artifact provenance, compatibility, publication trust, local selection, native installation, and rollback converge on one Cut identity and one explicit transition.",
  "authorityTransitions": [
    {
      "subject": "product-release-identity",
      "before": "SemVer plus per-artifact manifest roots",
      "after": "one immutable Product Release Cut with exact platform slices",
      "authorityRefs": ["framework/upgrade/kungfu-product-release-cut.contract.json", "docs/adr/KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239.md"]
    },
    {
      "subject": "product-update-movement",
      "before": "version precedence and adapter-local selection rules",
      "after": "explicit Cut Transition with lineage, compatibility, migration, rollback, trust, and evidence",
      "authorityRefs": ["framework/upgrade/kungfu-product-release-cut.contract.json", "framework/upgrade/kungfu-upgrade.contract.json"]
    },
    {
      "subject": "local-product-installation",
      "before": "Shifu desktop selection and native CLI archive installation with separate provenance",
      "after": "Shifu selects one same-slot KFD-3 product bundle and native Core owns CLI install, selection, and rollback",
      "authorityRefs": ["docs/guides/upgrading.md", "docs/shifu/schema/local-artifact-catalog-v1.schema.json"]
    }
  ],
  "retiredSurfaces": ["SemVer as exact product identity", "Shifu as a second CLI installer", "source cache as rollback authority", "implicit same-version replacement"],
  "unlockedCapabilities": ["same-SemVer successor qualification", "public signed supersession", "publication-ineligible local dogfood Cuts", "cache-independent native rollback", "cross-platform Cut-bound release evidence"],
  "downstreamConsumers": ["signed release channels", "bootstrap installers", "KFD-3 product registration", "Shifu promotion", "native updater", "Buildchain release qualification"],
  "evidence": [
    { "kind": "adr", "ref": "docs/adr/KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239.md", "label": "Product Release Cut identity decision" },
    { "kind": "document", "ref": "framework/upgrade/kungfu-product-release-cut.contract.json", "label": "Executable Cut and transition contract" },
    { "kind": "document", "ref": "docs/guides/upgrading.md", "label": "Updater and Shifu ownership guide" }
  ],
  "readerRoute": {
    "intent": "Understand exact product identity and how local or public updates move between releases",
    "start": "docs/guides/upgrading.md",
    "deepen": ["framework/upgrade/kungfu-product-release-cut.contract.json", "docs/adr/KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239.md", "docs/development/versioning.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This Stage keeps public release authority and local dogfood authority separate.
It records the first exact-identity spine; completing public cross-platform
release campaigns can extend or settle it without redefining the Cut.
