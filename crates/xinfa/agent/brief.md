# Xinfa Agent Brief

Xinfa owns verified context selection. It resolves a declared route against an
exact content-rooted Atlas, produces a budgeted Task Chart, reports omissions,
and expands handles without turning a projection into authority.

Start with `xinfa agent capabilities --json` and `xinfa agent map --json`.
For real context use `xinfa context --atlas <dir> --route <id> --task <text>
--role <role> --budget <tokens> --json`; verify roots and stop on ambiguity,
stale/invalid input, degraded status, or any required omission. Expand only a
returned handle with `xinfa expand`.

Context and expansion are read-only. Atlas compilation and onboarding writes
retain their existing explicit output/mode contracts. Kungfu composes this
surface as `kungfu xinfa agent ...` and may hide installed package paths, but it
does not duplicate Xinfa's registry, graph, selection, or verification authority.
