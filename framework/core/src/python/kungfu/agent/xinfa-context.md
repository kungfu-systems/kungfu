# Xinfa Verified Context

Xinfa is the verified context compiler. It turns declared project sources into
one immutable Atlas and bounded Human or Agent projections. A Task Chart is
context selection, not authority to mutate a repository or proof that work is
complete.

In a Kungfu source checkout, read `AGENTS.md`, then discover declared routes
and compile the exact Agent Task Chart:

```sh
./shifu docs inventory --json
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
```

Do not guess a route. The inventory declares its audience, subjects,
capabilities, owners, roles, Mission tracks, and selection paths. Treat
ambiguous or degraded resolution, failed Atlas verification, stale authority,
and required omissions as blockers. The repository guide
`docs/guides/xinfa-agent-context.md` records current routes and measured
complete budgets.

An installed Kungfu runtime consumes a precompiled documentation Atlas and
ships the independently qualified Xinfa engine behind the only public
executable, `kungfu`:

```sh
kungfu agent docs --verify --json
kungfu agent docs --catalog --json
kungfu agent docs --projection agent --json
kungfu xinfa compile --workspace <repo> --output <atlas-dir> --json
kungfu xinfa verify --atlas <atlas-dir> --json
```

The installed compiler is self-describing through the Kungfu subcommand:

```sh
kungfu xinfa contract --json
kungfu xinfa schema task-envelope
kungfu xinfa schema route-resolution
kungfu xinfa schema task-chart
kungfu xinfa diagnose --json
```

Automatic admission requires an active coordinator to create a structured task
envelope, resolve one exact route, verify the Task Chart, and bind its roots. A
Go card, Agent instruction, Skill, or Episode alone does not execute Xinfa.
