# Trademark public-use qualification

This qualification keeps four states separate:

1. the brand signature is implemented in source and public copy;
2. a future release has the surfaces needed to make a public-use record;
3. downloadable software is actually available through those surfaces; and
4. any legal conclusion about first use or registration is made outside this
   engineering contract.

The exact source-identifying signature is **Kungfu UNGFU™**, paired with
**Never Guess. Facts Unfold.** Kungfu remains the product name. UNGFU is not a
second product, runtime, package, CLI, domain, KFD layer, Buildchain component,
or libkungfu replacement.

## Current state

Kungfu v4 is Coming Soon. Public release artifacts are not available, so the
repository does not claim released-software use or a first-use date. Source
code, a pull-request preview, staging, a screenshot without a real acquisition
path, and a Coming Soon page do not satisfy this gate.

The machine-readable current state and release requirements live in
[`kungfu-trademark-public-use.contract.json`](../../framework/release/kungfu-trademark-public-use.contract.json).
Source acceptance runs `scripts/check-trademark-public-use.mjs` and its negative
fixtures.

## Gate for the first real public release

Before `releasedSoftwareUseClaim` can become true, one reviewable change must
provide both:

- a public download or package-install surface where **Kungfu UNGFU™** appears
  next to the real acquisition path; and
- at least one stable product-controlled surface—launch, About, or
  `kungfu --version`—that displays the exact mark.

The release gate does not rename the `kungfu` CLI, packages, repositories,
domains, KFD, Buildchain, or libkungfu. The signature identifies source; it does
not replace the product name.

## Public-safe evidence record

Record only public material. Each evidence record must include:

- the public URL and access date;
- source repository and exact source commit;
- the deployment or release coordinate;
- rendered evidence showing the mark beside the acquisition path and in the
  selected product surface.

Do not include private applications, searches, counsel correspondence, entity
records that are not already public, credentials, or unpublished release
coordinates. Do not infer or backdate a first-use date. A reviewer may confirm
that the engineering evidence is complete; that confirmation is not legal
advice, a registration claim, or a legal determination of first use.

## Review boundary

The implementation PR proves copy, ownership attribution, exact-mark surfaces,
and executable negative tests. The future release PR proves real acquisition
and product surfaces. Production publication and any legal conclusion remain
separate explicit review gates.
