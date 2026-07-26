# Kungfu Alpha Status

Last reviewed: 2026-07-26.

## Current availability

**Kungfu product Alpha publication is blocked.** This page does not announce an
available product channel, authorize promotion, or qualify an artifact.

The existing `shifu-v4.0.0-alpha.0` GitHub release is a Shifu tooling release.
It is not evidence that a Kungfu product Alpha for macOS, Linux, or Windows is
available.

| Surface | Current public status | Support boundary |
| --- | --- | --- |
| Kungfu product Alpha channel | Not available under this readiness process | No artifact should be inferred from source branches or tooling releases |
| Source checkout | Engineering evaluation only | Best effort; no public response SLA |
| macOS product artifact | Not yet admitted here | Requires exact artifact and qualification evidence |
| Linux product artifact | Not yet admitted here | Requires exact artifact and qualification evidence |
| Windows product artifact | Not yet admitted here | Requires exact artifact and qualification evidence |

The target platform matrix is macOS arm64, Linux x86_64, and Windows x86_64.
A platform becomes supported on this page only after an exact product artifact,
installation path, and qualification receipt are linked. Absence from the table
is not an implied compatibility claim.

## Publication gate

Publication remains fail-closed until all of the following are current:

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

## Support and duplicates

Alpha support is best effort and has no public response-time SLA. Reproducible
defects belong in Issues; questions and open-ended help belong in Discussions;
vulnerabilities belong in private reporting.

Search [Known Issues](known-issues.md) before filing. If an existing issue
matches, add only new, sanitized evidence there. Maintainers keep one canonical
issue open, link duplicates, and close a duplicate only after human review. A
duplicate is not evidence that the impact is unimportant.
