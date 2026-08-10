# GitHub Webhook Event View

This view is independent of Dogfood and requires no runtime capability. Paste
one JSON object or JSONL exported from the GitHub ingress qualification or
runtime evidence surface to inspect authentication, delivery identity,
normalization, no-op/rejection codes, replay results, content roots, and
asynchronous processing outcome.

The view does not execute payload content, fetch GitHub URLs, display retained
raw payloads, or create any domain effect. Invalid input is shown as bounded
local diagnostics.
