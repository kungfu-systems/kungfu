# `kungfu run agent` OpenCode continuity qualification

This preparatory qualification exercises one local golden path:

```text
verified OpenCode Runtime Profile
-> fresh Agent A inspects the bounded fixture
-> Agent A submits a partial completion Claim
-> a deterministic independent Assessment preserves the exact remaining action
-> fresh Agent B receives only WorkRef plus a continuation envelope
-> the exact oracle passes
-> an independently accepted successor Project Cut is settled
```

It reuses the tiny inventory fixture and oracle from
[Continuity Pilot v1](continuity-pilot.md). It does not create a parallel
benchmark, read an OpenCode transcript or session database, modify provider
credentials, or change a global OpenCode configuration.

## Local run

Build Core, verify the local OpenCode executable, and run the disposable
qualification:

```bash
./shifu build:core
./shifu qualify:run-agent-opencode-continuity -- \
  --opencode "$HOME/.opencode/bin/opencode" \
  --model opencode/north-mini-code-free \
  --output /tmp/kungfu-run-agent-opencode
```

The command creates a dedicated Kungfu Home, config home, fixture workspace,
and fresh XDG directories below the output directory. It configures two local
profiles that resolve to the same verified executable: the default plan
profile launches Agent A and an explicit build profile launches Agent B.

The retained `continuity-report.json` includes:

- `distinct_agent_sessions = 2`;
- `prior_transcript_bytes_given_to_agent_b = 0`;
- `human_reexplanation_count = 0`;
- OpenCode executable, version, model, profile roots, source head, fixture
  roots, and input roots;
- the partial Claim, independent Assessment, transcript-free continuation
  envelope, exact oracle result, independent Decision, and successor Cut
  receipt; and
- the repeated semantic replay root and state-transition class.

Run the positive validator and fail-closed corpus with:

```bash
./shifu test:run-agent-opencode-continuity
```

The corpus rejects reused Agent sessions, transcript injection, human task
restatement, mismatched Claim/Assessment/continuation/Cut roots, missing
independent assessment, process exit or self-report presented as completion,
oracle failure, stale Warrant state, unadmitted successor settlement, and
semantic replay drift.

## Direct runtime profile use

OpenCode is a native Agent Runtime Profile provider:

```bash
kungfu agent runtime discover --json
kungfu agent runtime verify <opencode-profile-id> --json
kungfu agent runtime set-default <opencode-profile-id> --execute --json
kungfu run agent --workspace "$PWD" --prompt "Inspect this bounded task" --json
kungfu run agent --agent <opencode-profile-id> \
  --workspace "$PWD" \
  --continuation continuation.json \
  --prompt "Continue solely from the admitted envelope" \
  --json
```

`kungfu run agent` records a fresh Episode and provider response under the
selected Kungfu runtime. A zero process exit and an Agent self-report remain
observations only. The report leaves Work `unsettled` and names independent
assessment as the next action.

## Claim boundary

This qualification is local preparatory evidence for one deterministic
fixture and one tested OpenCode model. It is not FO10 evidence, a release Gate,
a provider comparison, a durability result, a GUI/TUI parity result, a cloud
or remote execution claim, or a multi-day continuity claim. The disposable
successor Cut is not published to Git.
