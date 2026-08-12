# Kungfu Alpha Status

Last reviewed: 2026-08-09.

## Current availability

**Kungfu v4.0.0-alpha.1 is the first public product Alpha.** It is available
from the immutable
[GitHub release](https://github.com/kungfu-systems/kungfu/releases/tag/v4.0.0-alpha.1)
and the Buildchain-qualified [installation path](installing-cli.md). It is a
prerelease with best-effort support, not a Stable or generally available
release.

The older `shifu-v4.0.0-alpha.0` GitHub release remains a Shifu tooling
release. It does not describe the product Alpha channel.

| Surface | Current public status | Support boundary |
| --- | --- | --- |
| Kungfu product Alpha channel | `v4.0.0-alpha.1` published | Exact release, signed channel, Release Passport, and public readback are authoritative |
| Source checkout | Engineering evaluation only | A branch or local build is not the published Alpha |
| macOS arm64 | Desktop DMG/ZIP and standalone CLI published | Prerelease; exact Alpha evidence only |
| Linux x86_64 | Desktop AppImage and standalone CLI published | Prerelease; exact Alpha evidence only |
| Windows x86_64 | Desktop installer and standalone CLI published | Prerelease; the first Alpha is intentionally unsigned and does not claim Authenticode identity |

The target platform matrix is macOS arm64, Linux x86_64, and Windows x86_64.
A platform is listed only when the exact product artifact, installation path,
and qualification evidence are present in the release. Absence from the table
is not an implied compatibility claim.

## Current release and future publication gate

The public machine-readable status is
`https://kungfu.tech/.well-known/kungfu-release-status.json`. It identifies the
current release, source and site coordinates, channel, Release Passport, and
explicit legal non-claims. For any later Alpha publication, promotion remains
fail-closed until all of the following are current:

- the protected repository change is merged after independent review;
- GitHub Discussions and its `Q&A`, `Ideas`, and `Show and tell` categories have
  exact live readback;
- the label taxonomy and external-versus-automation queues have exact live
  readback;
- private vulnerability reporting remains enabled;
- the fixture rehearsal and repository checks pass on the exact candidate;
- launch commander, triage, reproduction, communications, moderation, and
  security escalation coverage are assigned for T-24 through T+48; and
- the parent publication decision cites the exact artifact and every unresolved
  risk.

The current staffing plan binds every human role to `dongkeren` and uses
`kungfu-origin` as a secondary review account, not as a second human. It
provides checkpoint-based monitoring from 08:00-24:00 `Asia/Shanghai` and a
protected 00:00-08:00 rest window. During that rest window, read-only
collection may continue, but publication, promotion, security disposition,
moderation decisions, and availability claims remain paused. Any future T-0
must be scheduled between 08:00 and 12:00.

## Support and duplicates

Alpha support is best effort and has no public response-time SLA. Reproducible
defects belong in Issues; questions and open-ended help belong in Discussions;
vulnerabilities belong in private reporting.

Search [Known Issues](known-issues.md) before filing. If an existing issue
matches, add only new, sanitized evidence there. Maintainers keep one canonical
issue open, link duplicates, and close a duplicate only after human review. A
duplicate is not evidence that the impact is unimportant.
