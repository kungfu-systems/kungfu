# Security Policy

## Reporting vulnerabilities

Please report security issues privately instead of opening a public issue.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**
([open directly](https://github.com/kungfu-systems/kungfu/security/advisories/new)).
The report stays private to the maintainers until a fix is coordinated.

Do not report vulnerabilities through public issues, pull requests, or
discussions.

If a public report appears to contain a vulnerability, do not continue
debugging the sensitive details in public. Preserve the public URL, ask the
reporter to use private vulnerability reporting, and let a human security owner
decide whether public content needs redaction or removal. An agent may identify
the report as a possible security signal, but it may not classify it as safe,
close it, or promise a disclosure timeline.

Include:

- affected version, commit, package, or release artifact;
- operating system and architecture;
- steps to reproduce;
- expected impact;
- whether the issue affects source builds, packaged artifacts, or runtime data.

## Scope

Security reports may cover:

- runtime or journal data integrity;
- local file access, path traversal, or unsafe archive handling;
- package, installer, or update-chain behavior;
- extension loading or execution boundaries;
- dependency or build-chain vulnerabilities;
- credential, token, or private data exposure.

Service-abuse, provider-compliance, credential-handling, or misleading official
identity reports may also be security-sensitive. Use private vulnerability
reporting when public disclosure would expose credentials, provider account
details, user data, or an exploitable bypass. See `ACCEPTABLE_USE.md`,
`PROVIDER_COMPLIANCE.md`, and `TRADEMARK.md` for the related policy boundaries.

## Public disclosure

Please allow maintainers time to investigate and prepare a fix before public
disclosure. The project will coordinate disclosure timing with reporters when a
confirmed vulnerability affects released artifacts.
