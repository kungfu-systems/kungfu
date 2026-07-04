#  SPDX-License-Identifier: Apache-2.0
#
# The Python trusted tier's in-process capability surface: the co-resident
# analogue of fixture-caps.ts. A trusted Python facet is co-resident with a
# Python-side binding (ADR-0014 §1.4: an adapter is co-resident instrumentation),
# so it reaches these capabilities in-process and by reference — genTime is a
# real Python int, not a serialized string. The sandbox tier, by contrast, is
# served by the Node host over the relay and receives the decimal-string copy.

_FIXTURE_FRAMES = [
    {"genTime": 1_700_000_000_000_000_001, "msgType": 101, "source": 11, "dest": 21},
    {"genTime": 1_700_000_000_000_000_002, "msgType": 102, "source": 12, "dest": 22},
    {"genTime": 1_700_000_000_000_000_003, "msgType": 103, "source": 13, "dest": 23},
]


class _Ledger:
    def records(self, filt=None):
        limit = (filt or {}).get("limit", len(_FIXTURE_FRAMES))
        return [dict(frame) for frame in _FIXTURE_FRAMES[:limit]]

    def health(self):
        return {"joined": False, "live": False, "usable": False}


class _Report:
    def __init__(self):
        self.value = None

    def result(self, value):
        self.value = value


def build_caps():
    """Return (caps, report_sink): exactly the declared capabilities, in-process."""
    report = _Report()
    return {"ledger": _Ledger(), "report": report}, report
