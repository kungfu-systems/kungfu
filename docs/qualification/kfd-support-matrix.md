# Kungfu KFD support matrix

This document is a deterministic projection of `.buildchain/kfd/adopter-manifest.json` and its exact passing Buildchain gate. The standard full-cut manifest is the sole Kungfu adoption declaration authority; this page, the SDK copy, CLI output, Release Passport and legacy matrix cannot widen it.

| Standard | State | Usage | Implementation | Verification | Buildchain | Next gate |
| --- | --- | --- | --- | --- | --- | --- |
| KFD-1 | candidate | used | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-2 | candidate | used | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-3 | candidate | used | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-4 | candidate | used | implemented | passed | passed | Release Passport artifact binding and independent release decision |
| KFD-5 | candidate | evaluating | implemented | passed | passed | Release Passport artifact binding and independent release decision |
| KFD-6 | unsupported | unused | not-declared | not-declared | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-7 | candidate | used | implemented | passed | passed | Release Passport artifact binding and independent release decision |
| KFD-8 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-9 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-10 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-11 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-12 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |
| KFD-13 | draft-evidence | evaluating | implemented | passed | manifest-verified | Release Passport artifact binding and independent release decision |

## Claim boundary

- Candidate rows retain implementation and verification evidence without claiming completed adoption or shipment.
- KFD-6 is explicitly unsupported and unused.
- KFD-8 through KFD-13 retain draft evidence only; draft evidence cannot activate a decision.
- The manifest gate is non-qualifying and non-self-certifying. Runtime permission, release authority and independent certification remain separate.

## Inspect this source with Shifu

Run `./shifu kfd status --json` for the source projection and `./shifu kfd check --json` to verify the manifest, gate, evidence roots and every compatibility projection.
