#  SPDX-License-Identifier: Apache-2.0
#
# A Python facet — a real extension written once against the uniform capability
# surface (ADR-0014). This exact source runs unchanged in both trust tiers:
# co-resident (in-process, by reference) and sandboxed (an OS-sandboxed child
# reaching the host over the stdio relay). It never branches on the tier.
#
# What it observes IS the transport difference the contract hides from the
# author: it reads records from the ledger capability and reports the runtime
# type of a 64-bit genTime. Co-resident it is a Python int (by reference);
# sandboxed it is a decimal string (the JSON relay serialized it). The facet
# calls the same method either way and reports what it got.


def run(caps):
    records = caps["ledger"].records({"limit": 3})
    health = caps["ledger"].health()
    first = records[0]
    caps["report"].result(
        {
            "facet": "py",
            "recordCount": len(records),
            "firstGenTime": str(first["genTime"]),
            "genTimeType": type(first["genTime"]).__name__,
            "joined": health["joined"],
        }
    )
