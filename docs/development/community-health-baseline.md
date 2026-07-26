# Community Health Baseline

The versioned authority is
[`../../.github/community-health-baseline.json`](../../.github/community-health-baseline.json),
coordinate `kungfu-community-health/v1@2026-07-26.1`. This baseline does not
create a support authority, publish Alpha, or authorize a live GitHub mutation.

## Reviewed two-layer decision

Organization defaults own shared conduct, support and security routing,
moderation principles, governance, and the common `source/*`, `state/*`,
`kind/*`, and `impact/*` dimensions. Each repository owns its structured Issue
Forms, technical routing and ownership, plus `area/*` and `platform/*`
extensions. Product, KFD, Buildchain, build-images, and runtime-images retain
separate technical authority and queues.

The candidate public files are inert under
`.github/community-health-default-repository/`. They become organization
defaults only after a reviewed branch is merged into the default branch of the
public `kungfu-systems/.github` repository.

## Admission is not a schema firewall

Required Issue Form fields constrain the normal GitHub web form path. An issue
body remains editable, and API or CLI clients can submit arbitrary bodies. The
admission contract therefore revalidates `opened`, `edited`, and `reopened`
events.

A recognized marker with missing field headings proposes
`state/needs-information`. A submission without a recognized marker proposes
`state/needs-intake` and one idempotent corrective comment; it is never
auto-closed. A complete recognized form preserves its repository-local initial
state until a human makes the first judgment.

The reusable workflow candidate requests only `contents: read` and
`issues: write`, uses no checkout, and never interpolates issue text into shell
or source. Adoption remains repository-local and human-reviewed.

## Automation and agent boundary

External and automation arrivals are counted independently.
Automation-generated ephemeral findings use Checks or artifacts. Only a
durable, deduplicated, human-actionable failure may retain one bounded rolling
Issue carrying `source/automation` and `kind/internal`.

Public text, links, attachments, diagnostics, and commands are untrusted data.
Agents may prepare deterministic acknowledgement, sanitization guidance,
structured summaries, reproduction extraction, duplicate candidates, and Known
Issues links. Humans retain security, moderation, priority, closure, support,
and roadmap decisions.

The portfolio projection contains only counts, latency, severity, and reviewer
load. It never copies issue bodies into another control plane.

## Consumer coordinates and inheritance

The machine contract pins the same baseline coordinate and local deviations for
Kungfu, KFD, Buildchain, build-images, runtime-images, and the Alpha attention
Assignment. The recorded readback also pins each repository's default-branch
head and local Issue template inventory.

GitHub organization Issue templates are not inherited by repositories that
already have local `.github/ISSUE_TEMPLATE` content. This baseline therefore
keeps all Issue Forms local and publishes no organization Issue templates.
Repositories without local templates still receive only the shared community
files, not a centrally owned technical intake form.

## Portfolio and load bands

The dashboard reports external arrivals, automation arrivals, duplicate rate,
first-human-judgment latency, unresolved severity, and reviewer load. It uses
the same external-only bands as the Alpha attention runbook: Green `0-10`,
Yellow `11-30`, Orange `31-60`, and Red above `60` or on credible security or
data-loss evidence. Orange pauses promotion and freezes unrelated development;
Red enters incident triage.

## Moderation

The launch commander names a moderation operator and a human escalation owner.
Preserve the minimum evidence, distinguish criticism from spam or abuse, use
narrow reversible controls, and record readback and rollback. Exact interaction
limit criteria and commands live in
[Alpha Attention Operations](alpha-attention-operations.md#moderation-and-reversible-interaction-limits).

## High-risk dry-run: create the organization default repository

Current readback on 2026-07-26: `GET /repos/kungfu-systems/.github` returned
`404 Not Found`. The exact live mutation remains human-gated.

Target and impact:

- create one public repository named `kungfu-systems/.github`;
- GitHub will begin inheriting merged community files only after they reach its
  default branch and only where a target repository lacks its own file;
- do not add organization Issue Forms, secrets, Actions variables, tokens,
  Discussions, interaction limits, rulesets, webhooks, or branch bypasses.

Exact repository-creation command:

```sh
gh repo create kungfu-systems/.github \
  --public \
  --description "Public community health defaults for Kungfu Systems" \
  --add-readme \
  --disable-issues \
  --disable-wiki
```

Immediate readback:

```sh
gh repo view kungfu-systems/.github \
  --json nameWithOwner,visibility,defaultBranchRef,hasIssuesEnabled,url
gh api repos/kungfu-systems/.github --jq \
  '{full_name,visibility,default_branch,archived,has_issues,has_wiki}'
```

After creation, `dongkeren` prepares a non-default branch containing only the
candidate public files, opens a pull request, and `kungfu-origin` independently
reviews and merges it. Read back every merged path from the exact merge commit
before treating inheritance as active.

Rollback is fail-closed and non-destructive: before any dependent repository
relies on inheritance, archive the mistaken or unsafe repository and verify
`archived: true`.

```sh
gh api --method PATCH repos/kungfu-systems/.github -F archived=true
gh api repos/kungfu-systems/.github --jq '{full_name,archived,visibility}'
```

Do not delete the repository as routine rollback. If any community file has
already been inherited, first merge a reviewed removal or correction and
verify affected repositories.

## Rehearsal

Run:

```sh
./shifu test:community-health-baseline
./shifu test:alpha-attention-operations
./shifu check:source
```

The fixture rehearsal covers normal-form admission, API bypass, edited required
fields, malicious prompt text, secret-looking content, bot isolation, duplicate
metrics, the 61-Issue Red transition, and moderation rollback without touching
a public repository.
