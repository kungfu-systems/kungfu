# Acceptable Use Policy

This policy applies to official Kungfu services and maintainer-operated
infrastructure. It does not change the Apache-2.0 license for the source code in
this repository.

Examples of official services and infrastructure may include hosted sync,
managed sessions, relay services, mobile push, official release infrastructure,
official package distribution, official support channels, and maintainer-run CI
or deployment resources.

## Allowed Purpose

Official Kungfu services are intended to help users and teams manage legitimate
agent-assisted work with better cost visibility, work state, evidence, replay,
and recovery.

Users remain responsible for:

- the work they ask agents or automation to perform;
- the credentials, accounts, repositories, data, and systems they connect;
- complying with laws, upstream provider terms, and organization policies that
  apply to their use.

## Disallowed Use

Do not use official Kungfu services or infrastructure to:

- access systems, accounts, data, repositories, or services without
  authorization;
- steal, expose, sell, or mishandle credentials, tokens, session data, secrets,
  private keys, customer data, or private logs;
- bypass billing, quota, rate limits, approval flows, safety controls, or access
  controls of upstream providers;
- operate shared hidden provider accounts, credential pools, or proxy services
  that misrepresent who is using an upstream platform;
- generate or distribute malware, exploit chains, phishing infrastructure, or
  unauthorized intrusion tooling;
- overload, degrade, probe, or attack official Kungfu infrastructure or
  upstream provider infrastructure;
- misrepresent unofficial software, services, releases, or forks as official
  Kungfu offerings;
- use official services in a way that creates legal, security, abuse, or trust
  risk for other users, the maintainers, or upstream providers.

## Managed Agent Sessions

When Kungfu manages an agent session, the expected model is:

- the user owns the upstream account or credential;
- Kungfu records cost, state, evidence, approvals, and artifacts for the user's
  work;
- Kungfu does not provide hidden shared accounts or pooled credentials;
- Kungfu does not bypass provider billing, quota, rate-limit, or approval
  systems;
- attribution confidence is labeled honestly when cost or usage cannot be
  tied exactly to a run or session.

## Enforcement

The maintainers may refuse, suspend, limit, or terminate access to official
services or infrastructure for uses that violate this policy or create material
risk. They may also remove misleading official-brand claims from project
channels or package distribution surfaces they control.

Where practical, maintainers may contact affected users before taking action.
Immediate action may be taken for security incidents, abuse, infrastructure
risk, provider-risk incidents, or misleading official-brand use.

## Security Reports

Report vulnerabilities, credential exposure, or service-abuse issues through the
private reporting path in `SECURITY.md`, not through public issues.

