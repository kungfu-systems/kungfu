# Product build and runtime gates

These gates create or verify native product artifacts. They are heavy even when one command aggregates multiple internal stages.

Each section is bound to the registry id by the catalog meta gate.

<a id="product-distribution"></a>
<!-- gate-doc:product.distribution -->
## Product distribution build (`product.distribution`)

- **Problem:** Builds the native Kungfu distribution and release artifact tree.
- **Protects:** build regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu dist`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `product/release`.
- **Diagnosis:** `./shifu gate explain product.distribution --profile <profile>`; reproduce with `./shifu gate run product.distribution` on a capable runner.
- **Cost:** heavy; timeout 7200 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation); .github/workflows/linux-arm64-alpha-qualification.yml (artifact; alpha or release pull request, or isolated manual Linux ARM64 qualification)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:product.distribution -->

<a id="product-verify-full"></a>
<!-- gate-doc:product.verify-full -->
## Full product verification (`product.verify-full`)

- **Problem:** Rebuilds Core, freezes product, verifies runtime, slices, fixtures, and Episode smoke.
- **Protects:** build regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu verify --full`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`, `product-artifacts`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain product.verify-full --profile <profile>`; reproduce with `./shifu gate run product.verify-full` on a capable runner.
- **Cost:** heavy; timeout 7200 seconds.
- **Current source:** .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:product.verify-full -->

<a id="product-verify-fuzz"></a>
<!-- gate-doc:product.verify-fuzz -->
## Release verification with memory safety (`product.verify-fuzz`)

- **Problem:** Verifies release artifacts and runs sanitizer corpus replay plus bounded fuzzing.
- **Protects:** build regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu verify --fuzz`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`, `product-artifacts`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain product.verify-fuzz --profile <profile>`; reproduce with `./shifu gate run product.verify-fuzz` on a capable runner.
- **Cost:** heavy; timeout 7200 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:product.verify-fuzz -->
