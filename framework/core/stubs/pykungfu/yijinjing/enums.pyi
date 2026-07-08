from __future__ import annotations
import typing
__all__: list[str] = ['ACTOR', 'AssembleMode', 'BACKTEST', 'Connected', 'Continuous', 'DATA', 'DisConnected', 'FrameDataType', 'High', 'HistoryDataType', 'Intraday', 'JOURNAL', 'Json', 'LIVE', 'LOG', 'Low', 'Medium', 'NANOMSG', 'Normal', 'Now', 'OperatorState', 'PageEnd', 'PageStatus', 'Pending', 'PreOpen', 'Priority', 'REPLAY', 'Raw', 'Ready', 'ResumePolicy', 'SERVICE', 'SINK', 'SOURCE', 'SQLITE', 'SYSTEM', 'Stateless', 'TotalEnd', 'Unknown', 'get_layout_name', 'get_location_role_by_name', 'get_location_role_name', 'get_mode_by_name', 'get_mode_name', 'layout', 'location_role', 'mode']
class AssembleMode:
    All: typing.ClassVar[int] = 32
    Channel: typing.ClassVar[int] = 1
    Public: typing.ClassVar[int] = 8
    Read: typing.ClassVar[int] = 4
    Sync: typing.ClassVar[int] = 16
    Write: typing.ClassVar[int] = 2
    def __init__(self) -> None:
        ...
class FrameDataType:
    """
    Members:

      Raw

      Json

      Unknown
    """
    Json: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Json: 1>
    Raw: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Raw: 0>
    Unknown: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Unknown: 2>
    __members__: typing.ClassVar[dict[str, FrameDataType]]  # value = {'Raw': <FrameDataType.Raw: 0>, 'Json': <FrameDataType.Json: 1>, 'Unknown': <FrameDataType.Unknown: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class HistoryDataType:
    """
    Members:

      Normal

      PageEnd

      TotalEnd
    """
    Normal: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.Normal: 0>
    PageEnd: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.PageEnd: 1>
    TotalEnd: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.TotalEnd: 2>
    __members__: typing.ClassVar[dict[str, HistoryDataType]]  # value = {'Normal': <HistoryDataType.Normal: 0>, 'PageEnd': <HistoryDataType.PageEnd: 1>, 'TotalEnd': <HistoryDataType.TotalEnd: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OperatorState:
    """
    Members:

      Pending

      DisConnected

      Connected

      Ready
    """
    Connected: typing.ClassVar[OperatorState]  # value = <OperatorState.Connected: 3>
    DisConnected: typing.ClassVar[OperatorState]  # value = <OperatorState.DisConnected: 2>
    Pending: typing.ClassVar[OperatorState]  # value = <OperatorState.Pending: 0>
    Ready: typing.ClassVar[OperatorState]  # value = <OperatorState.Ready: 100>
    __members__: typing.ClassVar[dict[str, OperatorState]]  # value = {'Pending': <OperatorState.Pending: 0>, 'DisConnected': <OperatorState.DisConnected: 2>, 'Connected': <OperatorState.Connected: 3>, 'Ready': <OperatorState.Ready: 100>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class PageStatus:
    """
    Members:

      Normal

      PreOpen
    """
    Normal: typing.ClassVar[PageStatus]  # value = <PageStatus.Normal: 0>
    PreOpen: typing.ClassVar[PageStatus]  # value = <PageStatus.PreOpen: 1>
    __members__: typing.ClassVar[dict[str, PageStatus]]  # value = {'Normal': <PageStatus.Normal: 0>, 'PreOpen': <PageStatus.PreOpen: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Priority:
    """
    Members:

      Low

      Medium

      High
    """
    High: typing.ClassVar[Priority]  # value = <Priority.High: 2>
    Low: typing.ClassVar[Priority]  # value = <Priority.Low: 0>
    Medium: typing.ClassVar[Priority]  # value = <Priority.Medium: 1>
    __members__: typing.ClassVar[dict[str, Priority]]  # value = {'Low': <Priority.Low: 0>, 'Medium': <Priority.Medium: 1>, 'High': <Priority.High: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ResumePolicy:
    """
    Members:

      Now

      Intraday

      Stateless

      Continuous
    """
    Continuous: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Continuous: 3>
    Intraday: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Intraday: 1>
    Now: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Now: 0>
    Stateless: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Stateless: 2>
    __members__: typing.ClassVar[dict[str, ResumePolicy]]  # value = {'Now': <ResumePolicy.Now: 0>, 'Intraday': <ResumePolicy.Intraday: 1>, 'Stateless': <ResumePolicy.Stateless: 2>, 'Continuous': <ResumePolicy.Continuous: 3>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class layout:
    """
    Kungfu Data Layout

    Members:

      JOURNAL

      SQLITE

      NANOMSG

      LOG
    """
    JOURNAL: typing.ClassVar[layout]  # value = <layout.JOURNAL: 0>
    LOG: typing.ClassVar[layout]  # value = <layout.LOG: 3>
    NANOMSG: typing.ClassVar[layout]  # value = <layout.NANOMSG: 2>
    SQLITE: typing.ClassVar[layout]  # value = <layout.SQLITE: 1>
    __members__: typing.ClassVar[dict[str, layout]]  # value = {'JOURNAL': <layout.JOURNAL: 0>, 'SQLITE': <layout.SQLITE: 1>, 'NANOMSG': <layout.NANOMSG: 2>, 'LOG': <layout.LOG: 3>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class location_role:
    """
    Kungfu Location Role

    Members:

      SOURCE

      SINK

      ACTOR

      SYSTEM

      SERVICE
    """
    ACTOR: typing.ClassVar[location_role]  # value = <location_role.ACTOR: 2>
    SERVICE: typing.ClassVar[location_role]  # value = <location_role.SERVICE: 4>
    SINK: typing.ClassVar[location_role]  # value = <location_role.SINK: 1>
    SOURCE: typing.ClassVar[location_role]  # value = <location_role.SOURCE: 0>
    SYSTEM: typing.ClassVar[location_role]  # value = <location_role.SYSTEM: 3>
    __members__: typing.ClassVar[dict[str, location_role]]  # value = {'SOURCE': <location_role.SOURCE: 0>, 'SINK': <location_role.SINK: 1>, 'ACTOR': <location_role.ACTOR: 2>, 'SYSTEM': <location_role.SYSTEM: 3>, 'SERVICE': <location_role.SERVICE: 4>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class mode:
    """
    Kungfu Run Mode

    Members:

      LIVE

      DATA

      REPLAY

      BACKTEST
    """
    BACKTEST: typing.ClassVar[mode]  # value = <mode.BACKTEST: 3>
    DATA: typing.ClassVar[mode]  # value = <mode.DATA: 1>
    LIVE: typing.ClassVar[mode]  # value = <mode.LIVE: 0>
    REPLAY: typing.ClassVar[mode]  # value = <mode.REPLAY: 2>
    __members__: typing.ClassVar[dict[str, mode]]  # value = {'LIVE': <mode.LIVE: 0>, 'DATA': <mode.DATA: 1>, 'REPLAY': <mode.REPLAY: 2>, 'BACKTEST': <mode.BACKTEST: 3>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
def get_layout_name(arg0: layout) -> str:
    ...
def get_location_role_by_name(arg0: str) -> location_role:
    ...
def get_location_role_name(arg0: location_role) -> str:
    ...
def get_mode_by_name(arg0: str) -> mode:
    ...
def get_mode_name(arg0: mode) -> str:
    ...
ACTOR: location_role  # value = <location_role.ACTOR: 2>
BACKTEST: mode  # value = <mode.BACKTEST: 3>
Connected: OperatorState  # value = <OperatorState.Connected: 3>
Continuous: ResumePolicy  # value = <ResumePolicy.Continuous: 3>
DATA: mode  # value = <mode.DATA: 1>
DisConnected: OperatorState  # value = <OperatorState.DisConnected: 2>
High: Priority  # value = <Priority.High: 2>
Intraday: ResumePolicy  # value = <ResumePolicy.Intraday: 1>
JOURNAL: layout  # value = <layout.JOURNAL: 0>
Json: FrameDataType  # value = <FrameDataType.Json: 1>
LIVE: mode  # value = <mode.LIVE: 0>
LOG: layout  # value = <layout.LOG: 3>
Low: Priority  # value = <Priority.Low: 0>
Medium: Priority  # value = <Priority.Medium: 1>
NANOMSG: layout  # value = <layout.NANOMSG: 2>
Normal: PageStatus  # value = <PageStatus.Normal: 0>
Now: ResumePolicy  # value = <ResumePolicy.Now: 0>
PageEnd: HistoryDataType  # value = <HistoryDataType.PageEnd: 1>
Pending: OperatorState  # value = <OperatorState.Pending: 0>
PreOpen: PageStatus  # value = <PageStatus.PreOpen: 1>
REPLAY: mode  # value = <mode.REPLAY: 2>
Raw: FrameDataType  # value = <FrameDataType.Raw: 0>
Ready: OperatorState  # value = <OperatorState.Ready: 100>
SERVICE: location_role  # value = <location_role.SERVICE: 4>
SINK: location_role  # value = <location_role.SINK: 1>
SOURCE: location_role  # value = <location_role.SOURCE: 0>
SQLITE: layout  # value = <layout.SQLITE: 1>
SYSTEM: location_role  # value = <location_role.SYSTEM: 3>
Stateless: ResumePolicy  # value = <ResumePolicy.Stateless: 2>
TotalEnd: HistoryDataType  # value = <HistoryDataType.TotalEnd: 2>
Unknown: FrameDataType  # value = <FrameDataType.Unknown: 2>
