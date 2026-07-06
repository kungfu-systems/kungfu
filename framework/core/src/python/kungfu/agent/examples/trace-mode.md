# Trace Mode Example

Use trace mode when there is already a command to run.

```sh
kungfu trace -- python3 my_agent.py
kungfu rewind show <run-id>
kungfu rewind export <run-id> --out ./rewind-bundle
```

`trace` should wrap the command with minimal changes. If the command already has
its own model calls, tools, or subprocesses, keep them intact and let Rewind
capture what the runtime can observe.
