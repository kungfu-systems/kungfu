# Stage 13: Framework Package Owner Convergence

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "framework-package-owner-convergence",
  "era": "work-control-dogfood",
  "sequence": 13,
  "title": "Framework package owner convergence",
  "status": "open",
  "evolutionImpact": "opens",
  "period": { "start": "2026-09-04", "end": "ongoing" },
  "buildsOn": ["project-compatibility-zero-residue"],
  "pressure": "Framework mixed public npm packages with dozens of ownerless contract, internal-library, product, and repository-tool roots, so directory placement did not communicate distribution or semantic authority.",
  "priorLimitation": "Consumers depended on paths spread across 57 immediate framework directories; 46 of those roots had no package identity, while Work protocols, native state, portable declarations, products, and developer tooling shared one flat namespace.",
  "localCapability": "Spec, Core, and Work now provide explicit package owners for portable declarations, native execution and persistence, and Work lifecycle semantics; product and developer concerns live outside the framework package boundary.",
  "compression": "Forty-six source-only framework roots converge into three semantic package owners or their product and developer homes, leaving framework as an npm-package-only boundary.",
  "authorityTransitions": [
    {
      "subject": "framework-package-ownership",
      "before": "a flat framework tree mixing npm packages with ownerless source roots",
      "after": "an npm-package-only framework boundary owned by Spec, Core, Work, and existing runtime packages",
      "authorityRefs": ["framework/layout.manifest.json", "framework/README.md", "framework/work/README.md"]
    },
    {
      "subject": "continuation-boundary",
      "before": "Project Cut plus Xinfa Atlas and qualified continuation",
      "after": "Project Cut plus Xinfa Atlas and qualified continuation under the Work package owner",
      "authorityRefs": ["framework/work/project-cut/README.md", "docs/guides/xinfa-agent-context.md"]
    },
    {
      "subject": "product-release-identity",
      "before": "one immutable Product Release Cut with exact platform slices",
      "after": "one immutable Product Release Cut with exact platform slices under the product owner",
      "authorityRefs": ["product/upgrade/kungfu-product-release-cut.contract.json", "docs/adr/KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239.md"]
    },
    {
      "subject": "product-update-movement",
      "before": "explicit Cut Transition with lineage, compatibility, migration, rollback, trust, and evidence",
      "after": "product-owned Cut Transition with lineage, compatibility, migration, rollback, trust, and evidence",
      "authorityRefs": ["product/upgrade/kungfu-product-release-cut.contract.json", "product/upgrade/kungfu-upgrade.contract.json"]
    },
    {
      "subject": "temporal-relation-proof",
      "before": "canonical Fact-bound predicates and explicit bounded path receipts evaluated at one exact Cut",
      "after": "Core-owned canonical Fact predicates and bounded path receipts evaluated at one exact Cut",
      "authorityRefs": ["framework/core/fact/kungfu-fact-cut-kernel.contract.json", "framework/core/src/python/kungfu/storage/fact_root_canonical.py", "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md"]
    },
    {
      "subject": "work-authority",
      "before": "native Initiative, Assignment, Work Design, and Work Control without project-specific compatibility",
      "after": "native Initiative, Assignment, Work Design, and Work Control under one Work package boundary",
      "authorityRefs": ["docs/profiles/work-control.md", "framework/work/assignment-runtime/assignment-runtime.contract.json", "framework/work/README.md"]
    }
  ],
  "retiredSurfaces": ["source-only immediate framework roots", "framework-local product directories", "framework-local repository-tool directories"],
  "unlockedCapabilities": ["package-level ownership inspection", "zero source-only framework enforcement", "clean installed Work protocol consumption"],
  "downstreamConsumers": ["Kungfu runtime packages", "Work Control", "Project Cut", "release tooling", "repository maintainers"],
  "evidence": [
    { "kind": "document", "ref": "framework/layout.manifest.json", "label": "Package-only framework layout contract" },
    { "kind": "document", "ref": "framework/work/README.md", "label": "Work package authority boundary" },
    { "kind": "document", "ref": "product/release/npm-package-registry.json", "label": "Exact npm release inventory" }
  ],
  "readerRoute": {
    "intent": "Understand which package owns portable declarations, native state, and Work protocols after framework convergence",
    "start": "framework/README.md",
    "deepen": ["framework/spec/README.md", "framework/work/README.md", "framework/core/package.json"]
  },
  "amends": ["project-cut-xinfa-continuation", "initiative-assignment-portable-work", "product-release-cut-updater-convergence", "temporal-relation-proof", "project-compatibility-zero-residue"],
  "supersedes": []
}
```

This Stage updates current owner navigation without rewriting the settled
records that explain how the previously flat framework layout arose.
