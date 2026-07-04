# Provider Compliance Policy

Kungfu integrates with developer tools, agent runtimes, model providers, local
CLIs, package registries, release platforms, and cloud services. This policy
records the official integration posture.

The official project should make user work more observable and auditable. It
should not become a tool for bypassing upstream provider rules.

## Official Integration Posture

Official Kungfu integrations should use provider-supported or public surfaces,
such as:

- documented APIs and SDKs;
- documented CLI commands and structured output modes;
- OpenTelemetry or other documented telemetry exports;
- user-approved local process execution;
- GitHub Actions, package registries, and cloud APIs used according to their
  documented permission model;
- explicit user-provided credentials or environment configuration.

Official integrations should preserve the user's ability to understand:

- which provider or tool was used;
- which account, project, repository, or credential boundary was involved;
- what action was taken;
- what usage, cost, artifact, approval, or evidence was recorded;
- how confident Kungfu is about attribution.

## Prohibited Official Integration Patterns

Official Kungfu code and services must not intentionally:

- scrape private web application state when a documented API, CLI, telemetry, or
  export surface is the appropriate integration path;
- read browser cookies, private session databases, provider auth files, billing
  pages, or hidden local session stores to obtain usage or account data;
- share hidden provider accounts, rotate pooled credentials, or proxy user work
  through maintainer-owned accounts without clear terms and user consent;
- bypass or weaken provider billing, quota, rate-limit, approval, or safety
  systems;
- mislabel account-level or window-level usage as exact run-level cost;
- hide provider identity, model identity, execution surface, or credential
  boundary from the user;
- encourage users to violate upstream provider terms.

## User-Owned Credentials

Kungfu may run local tools or provider CLIs under credentials already configured
by the user. The official project should treat those credentials as user-owned
and should not copy, print, upload, sell, or repurpose them.

Credential handling should prefer:

- process-level use of the user's existing CLI login;
- documented environment variables or provider config files when the provider
  supports them;
- least-privilege tokens for hosted or team services;
- explicit user consent when a service needs to store or transmit a credential.

## Cost And Usage Attribution

Cost and usage facts must be labeled by confidence. Exact per-run structured
events are different from session deltas, account snapshots, or manual
estimates.

When concurrent sessions or external tools make attribution ambiguous, Kungfu
should say so instead of splitting cost by guesswork.

## Provider Requests

If an upstream provider reports that an official Kungfu integration creates
abuse, security, compliance, or infrastructure risk, maintainers should:

1. identify whether the behavior is official code, official service behavior, a
   third-party fork, or user configuration;
2. preserve enough evidence to understand the affected integration path without
   exposing user secrets;
3. disable, limit, or patch official behavior when needed;
4. clarify public documentation when the boundary was ambiguous.

This policy does not make the official project responsible for every third-party
fork or downstream use. It defines the posture of the official project and the
services maintained by its maintainers.

