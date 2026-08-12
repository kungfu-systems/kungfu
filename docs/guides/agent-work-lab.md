# Agent Work Lab

Agent Work Lab answers one bounded question: can a fresh Agent process continue
the same governed Work without receiving the previous chat? Start with the
interactive Lab:

```sh
kungfu agent-work-lab
```

In an interactive terminal, the root command and `kungfu agent-work-lab open`
enter the same Lab. In a pipe or script, the root command prints a short,
bounded command journey and exits without starting a TUI or scanning Work.

## Choose one next step

```sh
kungfu agent-work-lab watch
kungfu agent-work-lab tour --episode 1
kungfu agent-work-lab try
kungfu agent-work-lab test
kungfu agent-work-lab report
```

- `watch` is playback only. It uses the bundled deterministic fixture and does
  not claim that an installed Agent was tested.
- `tour` is playback only. Its temporary Project is removed when playback ends.
- `try` previews a persistent Starter Project. Review its destination and plan
  root, then repeat the exact command with `--expected-plan-root <root>
  --execute`. Kungfu creates, selects, and opens that Project; it is left in
  place for continued experimentation.
- `test` defaults to a non-writing same-Agent plan using the configured default
  or recommended Agent. Add `--execute` to authorize two fresh local Agent
  processes. Use `--target-agent claude` (or another label, provider, or exact
  profile ID) for a cross-Agent handoff.
- `report` root-verifies and opens the latest retained test result. Pass an exact
  report path to inspect another result. It fails with the command needed to
  create evidence when no result exists.

`test --events-json --execute` streams admitted public events and then the
canonical report. `--timeout`, `--output`, and exact profile IDs remain
available for automation. Agent discovery reads executable locations and
bounded version output; it does not read provider credentials, sessions,
billing, or private logs:

```sh
kungfu agent-work-lab agents
kungfu agent-work-lab agents --json
```

## Advanced and compatibility commands

The default help keeps the beginner journey small. Existing lower-level
commands such as `plan`, `demo`, `autoplay`, `project-tour`, `starter-plan`,
`starter-create`, `starter-resume`, `agent-plan`, and `agent-run` remain
compatible for exact automation. The complete machine-readable action catalog
is:

```sh
kungfu agent-work-lab catalog --json
```

The Lab never settles real Work. A successful Agent process or Lab result is
evidence, not completion authority. Return to All Work with `w`, then use the
normal independent review and settlement path for real Work.
