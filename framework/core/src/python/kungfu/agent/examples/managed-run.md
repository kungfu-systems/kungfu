# Managed Run Example

Use managed-run when Kungfu should launch the provider CLI and bind Skill
context before the run starts.

```sh
kungfu managed-run --provider claude --prompt "Inspect this failed trace"
kungfu managed-run --provider codex --prompt "Summarize the local work facts" --print-response
```

This mode is experimental. Treat provider cost as reported only when the
provider actually reports usage. If the provider reports tokens but no dollars,
the dollar cost is unknown, not zero.
