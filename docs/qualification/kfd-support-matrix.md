# Kungfu KFD support matrix

This document is generated from `.buildchain/kfd/support-matrix.json`. The KFD package remains the normative authority; this matrix is Kungfu's authority for adoption and support claims.

Source implementation is not the same as released support. Verification, Buildchain gating, and shipped release qualification are independent dimensions. The current Alpha release declaration ships KFD-1, KFD-2, KFD-3, KFD-7 only. The published `v4.0.0-alpha.1` Release Passport qualifies that exact bounded claim; every later release must carry its own passport.

| Standard | Normative | Product status | Implementation | Verification | Buildchain | Release qualification | Shipped | Next gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| KFD-1 | active r7 | source-supported | implemented | passed | passed | alpha-release-passport | yes | Retain and verify the exact Alpha release passport for every claimed release. |
| KFD-2 | active r3 | source-supported | implemented | passed | passed | alpha-release-passport | yes | Retain and verify all KFD-2 claim evaluations in every claimed Alpha release passport. |
| KFD-3 | active r5 | source-supported | implemented | passed | passed | alpha-release-passport | yes | Retain and verify the exact product-declared registry audit and artifact closure in every claimed Alpha release passport. |
| KFD-4 | active r10 | candidate | implemented-candidate-profile | passed | passed | not-qualified | no | Retain the exact-source gate and release passport, then obtain independent adopter evidence and an explicit release decision before changing shipped support. |
| KFD-5 | active r7 | candidate | implemented-candidate-profile | passed | passed | not-qualified | no | Retain the Primitive Management evidence roots and exact-source gate, then obtain independent adopter evidence and an explicit release decision before changing shipped support. |
| KFD-6 | draft r10 | unsupported | not-implemented | none | not-applicable | not-qualified | no | Keep unsupported; admit a separate causal-experience discovery initiative only after the listed missing gates have executable contracts and evidence. |
| KFD-7 | active r8 | source-supported | implemented | passed | passed | alpha-release-passport | yes | Retain and verify the exact KFD-7 product gate and support projection in every claimed Alpha release passport. |
| KFD-8 | draft r2 | draft-adopter-evidence | partial | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-8 activation and an adopter qualification contract exist. |
| KFD-9 | draft r2 | draft-adopter-evidence | partial | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-9 activation and an adopter qualification contract exist. |
| KFD-10 | draft r2 | draft-adopter-evidence | implemented-specialized-witness | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-10 activation and an adopter qualification contract exist. |
| KFD-11 | draft r2 | draft-adopter-evidence | partial | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-11 activation and independent qualification exist. |
| KFD-12 | draft r5 | draft-adopter-evidence | partial | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-12 activation and independent qualification exist. |
| KFD-13 | draft r4 | draft-adopter-evidence | partial | non-conforming-evidence | not-applicable-draft | forbidden-while-draft | no | Keep evidence non-conforming until KFD-13 activation and independent qualification exist. |

## Claim boundary

- KFD-1, KFD-2, KFD-3, and KFD-7 are the bounded shipped-support set for the current Alpha release declaration.
- KFD-3 uses Buildchain's product-declared registry audit directly. It currently has 195 declared surfaces and 0 release-Gate-enforced surfaces. Declaration is discoverability; it is not enforcement.
- KFD-4 passes one bounded observer/contrastive-replay product gate but remains a non-shipped adoption candidate.
- KFD-5 passes the bounded Assignment adopter gate and now binds the Primitive Management Plane, sole-intake incubation passports, and derived nine-entry catalog. It remains a non-shipped candidate; Buildchain does not self-qualify or activate it.
- KFD-6 remains explicitly unsupported. The matrix retains bounded, non-conforming Work Design precursor evidence while keeping implementation, verification, activation, and shipment claims false.
- KFD-8 through KFD-13 expose only non-conforming draft adopter evidence. They are not shipped support.

## Inspect this source with Shifu

`./shifu kfd status` gives a human-readable support verdict. `./shifu kfd status --json` exposes the same facts to an Agent. `./shifu kfd check --json` validates the checked-in matrix, evidence roots, projections, KFD-3 declared set, and every hard-Gate binding without installing dependencies or initializing a Kungfu runtime.

These Shifu commands qualify the exact source checkout. Prepared source maintainers can run the deeper `./shifu kfd:agent-runtime:qualify`, `./shifu kfd:agent-hub:qualify`, and `./shifu kfd:agent-hub:verify` gates. Installed-product users should use `kungfu agent hub qualify --output-dir <new-directory>` and then `kungfu agent hub verify --qualification-dir <directory>`; source evidence does not substitute for an installed artifact result.
