#  SPDX-License-Identifier: Apache-2.0
#
# kungfu.rewind.cost — provider cost/usage adapters (parse layer).
#
# Discover the Codex and Claude CLIs and parse their structured output into a
# normalized, honestly-attributed CostSnapshot. There is no journal and no wire
# event here — see model.py for why these are dataclasses until a later slice
# puts them on the rewind open layer.
#
# This subpackage is pure stdlib on purpose: it must import and run without the
# native pykungfu binding, so the parse contract can be tested on its own.

from kungfu.rewind.cost.model import (
    COST_SCHEMA_VERSION,
    AttributionLevel,
    CostSnapshot,
    ProviderRunMetadata,
    TokenUsage,
    confidence_for,
)
from kungfu.rewind.cost.discovery import (
    CODEX_APP_BUNDLE,
    ProviderDiscovery,
    discover_provider,
    discover_providers,
)
from kungfu.rewind.cost.codex import (
    parse_codex_exec_json_text,
    parse_codex_exec_jsonl,
)
from kungfu.rewind.cost.claude import parse_claude_print_json

__all__ = [
    "COST_SCHEMA_VERSION",
    "AttributionLevel",
    "CostSnapshot",
    "ProviderRunMetadata",
    "TokenUsage",
    "confidence_for",
    "CODEX_APP_BUNDLE",
    "ProviderDiscovery",
    "discover_provider",
    "discover_providers",
    "parse_codex_exec_json_text",
    "parse_codex_exec_jsonl",
    "parse_claude_print_json",
]
