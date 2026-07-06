# Agent Safety Boundaries

Kungfu starts from local proof, not trust in a claim.

Fact labels:

- **observed**: read directly from the installed runtime, local journal, local
  bundle, local command output, or package files.
- **reported**: provided by a provider CLI, external service, user, or imported
  text. Keep the source attached.
- **imported**: copied from another runtime, bundle, machine, or repository.
  Keep provenance and do not silently promote it to observed.
- **remote**: depends on a network service or remote machine. Treat availability,
  identity, and freshness as separate facts.

Boundaries:

- A Skill instructs an agent; it does not grant runtime authority.
- A kfx package is the executable trust artifact; its origin and trust tier are
  decided by Kungfu, not by the path where it was found.
- A managed run may report cost or token facts only when the provider actually
  reports them. Missing cost is unknown, not zero.
- Do not scrape private provider sessions, bypass billing or quota systems, or
  misrepresent usage attribution.
- Do not publish secrets, credentials, private logs, or local-only evidence as
  public support material.
