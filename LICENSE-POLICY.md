# License Policy

Kungfu is released under the [Apache License 2.0](LICENSE).

This page explains how that license is applied across the public repository and
how contributions are accepted.

## Project license

Unless a file says otherwise, source code, examples, documentation, build
scripts, tests, and repository metadata in this repository are licensed under
Apache-2.0.

Package manifests in this repository should use:

```json
"license": "Apache-2.0"
```

## Contributions

Kungfu uses the Developer Certificate of Origin (DCO), not a Contributor License
Agreement (CLA).

By contributing, you certify that you have the right to submit the contribution
under Apache-2.0 and that it may be distributed as part of Kungfu under that
license. Each commit in a pull request must include a DCO sign-off line:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s` to add this automatically.

## Trademarks and brand names

Apache-2.0 grants copyright and patent permissions. It does not grant trademark
rights. Names, logos, domain names, and product marks such as "Kungfu" and
"Kungfu Tracer" may be governed by separate brand guidelines.

See [TRADEMARK.md](TRADEMARK.md) for the official project mark and fork identity
boundary.

## Hosted and commercial services

The open source license covers this repository. Hosted services, team features,
enterprise support, managed deployments, commercial connectors, or other
services offered by the project maintainers may use separate terms.

See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md) for acceptable use of official hosted,
managed, or maintainer-operated services.

## Upstream provider integrations

Official Kungfu integrations should use documented provider APIs, CLIs,
telemetry, or other public integration surfaces, and should not bypass provider
billing, quota, approval, safety, credential, or rate-limit systems.

See [PROVIDER_COMPLIANCE.md](PROVIDER_COMPLIANCE.md) for the official provider
integration posture.

## Third-party software

Kungfu depends on third-party software. Source dependencies are declared in the
repository manifests and lockfiles. Binary or bundled release artifacts must
include the third-party notices and license information required by the
components they redistribute.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the repository-level
notice policy.
