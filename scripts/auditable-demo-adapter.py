#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Retired compatibility tombstone for the product-specific demo adapter."""

RETIREMENT_MESSAGE = (
    "auditable-demo-adapter.py is retired; use the declarative Buildchain "
    "auditable-demo scenario in .buildchain/auditable-demo.json"
)


def main() -> None:
    raise SystemExit(RETIREMENT_MESSAGE)


if __name__ == "__main__":
    main()
