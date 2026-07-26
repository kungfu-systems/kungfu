# Alpha Attention Operations

This runbook controls public attention from T-24 hours through T+48 hours around
a future Kungfu product Alpha. It does not authorize publication, production
deployment, promotion, moderation settings, or any other live mutation.

## Authorities and roles

The organization currently has one human operator. Every consequential role is
therefore bound to `dongkeren`. `kungfu-origin` is the secondary GitHub account
used for independent pull-request review and an account-level handoff; it is
not a second human and must not be represented as concurrent human coverage.

| Role | Primary human account | Secondary account | Responsibility |
| --- | --- | --- | --- |
| Launch commander | `dongkeren` | `kungfu-origin` | Owns the load band, pauses promotion, freezes unrelated work, and makes go/no-go recommendations |
| Issue triage operator | `dongkeren` | `kungfu-origin` | Counts external arrivals, checks form completeness, and obtains first human judgment |
| Technical reproduction owner | `dongkeren` | `kungfu-origin` | Reproduces only sanitized, bounded reports in an isolated environment |
| Communications owner | `dongkeren` | `kungfu-origin` | Maintains Alpha Status, Known Issues, and scheduled digests without promising an SLA |
| Moderation operator | `dongkeren` | `kungfu-origin` | Preserves abuse evidence and proposes proportionate reversible action |
| Security escalation owner | `dongkeren` | `kungfu-origin` | Receives private reports and decides security handling; never delegates disposition to an agent |

The launch commander and security escalation owner are decision roles. Agents
may prepare deterministic summaries and candidate updates, but may not occupy
those authorities.

### Single-operator coverage and rest

All times use `Asia/Shanghai`. Schedule any future T-0 between 08:00 and 12:00.
The monitored window is 08:00-24:00 and the protected rest window is
00:00-08:00. This is checkpoint-based human supervision, not a requirement for
continuous screen watching:

- read-only automation may count queues and prepare sanitized digest drafts;
- `dongkeren` reviews those drafts and makes every consequential decision;
- during the rest window there is no claimed human coverage, even if
  `kungfu-origin` remains technically available as an account;
- public mutations, security dispositions, moderation decisions, availability
  claims, and promotional amplification remain paused during the rest window;
- a pending elevated-impact signal stays fail-closed for `dongkeren` to review
  at the next monitored checkpoint.

## Routing and queues

The machine-readable source is
[`../../.github/alpha-attention-operations.json`](../../.github/alpha-attention-operations.json).

- Reproducible bugs, install failures, documentation defects, and bounded
  feature requests use Issues.
- Questions, ideas, showcases, and open-ended support use Discussions.
- Vulnerabilities use private vulnerability reporting.
- Pull requests contain reviewed code or documentation changes.
- There is no email, helpdesk, chat, or mirrored Atlas inbox.

Use these equivalent saved queues:

```text
External new:
is:issue is:open label:"source/external" label:"state/needs-triage" -label:"source/automation"

External elevated impact:
is:issue is:open label:"source/external" label:"impact/data-loss","impact/security","impact/continuity","impact/blocking"

Automation only:
is:issue is:open label:"source/automation" -label:"source/external"
```

External arrival counts include only `source/external`; automation trackers,
Dependabot, patrol, drift, and GitHub Checks never count as demand. Recurring
machine findings should prefer Checks. If an issue is required, keep one rolling
tracker carrying `kind/internal` and `source/automation`.

## Load bands and actions

Count new external Issues over the preceding 24 hours. Credible security or
data-loss evidence forces Red regardless of count.

| Band | New external Issues / 24 h | Required action |
| --- | ---: | --- |
| Green | 0-10 | Normal triage and scheduled digest |
| Yellow | 11-30 | Add a triage pass, consolidate duplicates, and warn the launch commander |
| Orange | 31-60 | Pause promotional amplification and freeze unrelated development; focus on intake, reproduction, Known Issues, and operator rest |
| Red | More than 60, or credible security/data-loss evidence | Enter incident-mode triage, keep promotion paused, maintain the freeze, and require human go/no-go decisions |

Criticism, negative sentiment, or a popular inconvenient bug does not change the
band by itself and is never a moderation trigger.

## Timeline

### T-24 to T-12

- Confirm the checked-in `dongkeren` role bindings, the `kungfu-origin`
  secondary-account boundary, and the 00:00-08:00 protected rest window.
- Read back repository settings, Discussions categories, labels, queues,
  private vulnerability reporting, branch protection, and the current
  interaction limit.
- Run the fixture rehearsal and source checks on the exact candidate.
- Review Alpha Status and Known Issues; unproven availability remains blocked.
- Establish the first external and automation counts separately.

### T-12 to T-0

- Run an account-level handoff drill between `dongkeren` and `kungfu-origin`
  without claiming a second human operator.
- Rehearse security and data-loss fast paths using fixtures only.
- Rehearse the interaction-limit enable/readback/disable sequence without
  enabling it on the public repository.
- Publish no availability claim until the parent decision binds exact artifacts
  and every gate.

### T-0 to T+12

- Record the load band every two hours and after any fast-path signal.
- Triage external new reports before reading the automation lane.
- Update Known Issues only after human confirmation.
- At Orange or Red, apply the required promotion pause and development freeze.

### T+12 to T+24

- Produce six-hour digests: external arrivals, duplicate rate, first-human-
  judgment latency, unresolved elevated impact, automation count, staffing, and
  current band.
- Hand off with canonical issue links and sanitized facts, never copied issue
  bodies.
- Re-evaluate work/rest coverage before the next interval.

### T+24 to T+48

- Continue six-hour digests until two consecutive Green intervals.
- Keep Red incident handling separate from routine roadmap work.
- Record every Known Issues change, moderation decision, and rollback.
- At T+48, close the launch window only after unresolved risks and owners are
  handed to normal maintenance.

## Deterministic agent boundary

Public bodies, attachments, links, diagnostics, and suggested commands are
untrusted data. The repository rehearsal passes them only to pure string
processing. It never invokes a shell, evaluates code, follows a link, downloads
an attachment, checks out contributor code, or reads credentials.

An agent may propose a constant acknowledgement, sanitization guidance,
structured summary, reproduction extraction, duplicate candidates, and Known
Issues links. Every proposal carries `humanReviewRequired: true`. A human decides
security disposition, moderation, closure, priority, support commitments,
roadmap commitments, and live settings.

## Security and data-loss fast paths

For a possible vulnerability:

1. preserve the public URL and minimum timestamp;
2. stop public debugging of sensitive details;
3. direct the reporter to private vulnerability reporting;
4. notify the human security escalation owner; and
5. let that owner decide redaction, disclosure, and release impact.

For possible data loss or corruption, preserve the artifact identity and
sanitized reproduction, stop promotional amplification, enter Red, and require
the launch commander plus technical owner to decide the product state. Do not
ask an agent to execute the report.

## Moderation and reversible interaction limits

Preserve URLs, timestamps, GitHub report receipts, and minimal screenshots.
Avoid copying abusive or private material. The moderation operator proposes an
action; the escalation owner decides it. Interaction limits are reserved for a
sustained spam or abuse wave that cannot be contained with report, hide, block,
and ordinary moderation controls. They are never used for criticism.

Enable criteria:

- the load is Red because of observed spam or abuse, not ordinary feedback;
- the evidence and narrower attempted controls are recorded;
- scope and expiry are explicit; and
- a human escalation owner confirms the exact mutation.

Disable criteria:

- the abusive wave has stopped for two observation intervals;
- normal contributors are materially blocked;
- the configured expiry is approaching without renewed evidence; or
- the escalation owner determines the restriction is disproportionate.

The rehearsal records these exact commands but does not execute them:

```sh
# Readback
gh api repos/kungfu-systems/kungfu/interaction-limits

# Human-confirmed, one-day restriction for a verified abuse incident
gh api --method PUT repos/kungfu-systems/kungfu/interaction-limits \
  -f limit=contributors_only -f expiry=one_day

# Immediate rollback
gh api --method DELETE repos/kungfu-systems/kungfu/interaction-limits

# Post-rollback readback; GitHub should return no active restriction
gh api repos/kungfu-systems/kungfu/interaction-limits
```

The impact is temporary restriction of interaction by users who are not prior
contributors. Rollback deletes only the temporary restriction, not content,
issues, or evidence. Current credentials may not have repository-admin access;
a 403 is a failed readiness signal, not permission to broaden an agent token.

## Live activation plan

Live activation is a high-risk configuration change and requires a current
human confirmation after review of the exact target, impact, readback, and
rollback.

1. Enable Discussions for `kungfu-systems/kungfu` only:

   ```sh
   gh api --method PATCH repos/kungfu-systems/kungfu -F has_discussions=true
   gh api repos/kungfu-systems/kungfu --jq '{has_issues,has_discussions}'
   ```

   Rollback is the same PATCH with `has_discussions=false`; perform it only
   after preserving or relocating any real Discussion content.

2. Verify the `Q&A`, `Ideas`, and `Show and tell` categories through a read-only
   GraphQL query before Issue contact links become live. Missing categories
   block activation; do not silently route users back to Issues.

3. Create each missing label from the checked-in contract without renaming or
   deleting existing labels. Read back names, colors, and descriptions and
   compare them byte-for-byte with the contract. Rollback for a newly created
   unused label is deletion; a label already attached to an issue requires a
   separately reviewed migration and must not be deleted as routine rollback.

4. Run the three queue queries and prove that the rolling dev patrol tracker is
   automation-only while external reports remain independently visible.

5. Confirm private vulnerability reporting and the protected development
   ruleset remain enabled. Do not weaken required review, DCO, checks, or the
   merge queue.

## Rehearsal and handoff

Run:

```sh
./shifu test:alpha-attention-operations
./shifu check:source
```

The rehearsal covers form validation, routing, label dimensions, automation
separation, malicious public text, duplicate candidates, Known Issues,
threshold transitions, role handoff, and interaction-limit rollback. It changes
no live GitHub setting.

The parent publication handoff must contain:

- exact protected PR, merge commit, and target branch;
- live setting, category, label, queue, private-reporting, and ruleset readback;
- rehearsal command and receipt root;
- unresolved risks and the current Alpha Status;
- named launch and backup coverage; and
- the explicit statement: **Kungfu product Alpha publication remains blocked
  until every readiness criterion is satisfied.**
