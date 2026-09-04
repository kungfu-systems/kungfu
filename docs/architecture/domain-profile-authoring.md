# Domain Profile authoring contract

The machine authority for this document is
[kungfu-domain-profile-authoring.contract.json](../../framework/work/profile/kungfu-domain-profile-authoring.contract.json).
The reference KFX Profile Suite source package is generated from that contract.
Edit the contract, not the generated example or this document.

A Domain Profile declares adopter-specific objects, responsibility mappings,
workflows, operations, policy artifacts, settlement, Cut projection, and
migration. It consumes Action Geometry, Fact, Episode, KFX Profile Suite, and
Project Cut authority; it does not replace any of them. Core computes installed
roots and owns lifecycle mutation receipts.

## Authoring and lifecycle

The declaration schema is kungfu.domain-profile-declaration/v1. The public
lifecycle vocabulary is: `inspect`, `validate`, `register`, `qualify`, `install`, `activate`, `deactivate`, `upgrade`, `rollback`, `export`, `import`.

Activation is fail closed until the exact declaration and Profile Suite roots,
a valid supply-chain signature, a fresh qualification receipt, a compatible
migration path, and explicit capability grants are all present. A source
declaration or successful schema check is not activation evidence.

## Responsibility boundary

Every Profile maps exactly one domain object to each of Fact, Episode, Pursuit,
Atlas, and Warrant. Physical storage or UI components may be shared, but the
five responsibilities remain independently inspectable. Claim, Assessment,
Decision, and Admission policy owners are fixed by the authoring contract and
cannot be fused for convenience.

## Qualification checks

- `unique-object-and-operation-ids`
- `exact-five-responsibility-mappings`
- `no-role-fusion`
- `declared-object-and-operation-references`
- `acyclic-dependencies`
- `closed-workflow-states`
- `claim-assessment-decision-admission-separation`
- `settlement-binds-episode-and-warrant`
- `cut-projection-declares-omissions`
- `migration-preserves-authority-and-history`

## Reference Profile

The generated Course Production package is deliberately non-software. It is a
hash-closed KFX Profile Suite source tree with domain objects, a release
workflow, explicit residual risk, a settlement requiring both Episode and
Warrant, and a Cut projection with declared omissions. It is an authoring
fixture, not a signed installable package or a qualification receipt.

## Non-claims

- A declaration is an installed or active Profile Suite.
- The reference package carries a real package signature or qualification receipt.
- A Domain Profile may mint Fact, Episode, Action Geometry, or Project Cut authority.
- The authoring verifier proves business outcomes or supply-chain safety.
- Current language bindings already expose equal Domain Profile lifecycle coverage.
