from __future__ import annotations
import pykungfu.yijinjing.enums
import typing
__all__: list[str] = ['AcceptedRangeRecorded', 'Band', 'CacheReset', 'Channel', 'ChannelCursorUpdated', 'ChannelRequest', 'Config', 'Deregister', 'EpisodeClosed', 'EpisodeFrameAttached', 'EpisodeHeartbeat', 'EpisodeOpen', 'EpisodeRefAttached', 'ExportBundleRecorded', 'ImportManifestAccepted', 'Location', 'ManifestEntryRecorded', 'OperatorStateUpdate', 'OutputKey', 'Register', 'RequestCachedDone', 'RequestReadFrom', 'RequestReadFromOthers', 'RequestReadFromPublic', 'RequestReadFromSync', 'RequestWriteTo', 'RequestWriteToBand', 'SourceHeadUpdated', 'SourceRegistered', 'SyntheticData', 'TimeKeyValue', 'TimeRequest', 'TimeReset', 'TimeValue', 'frame_header', 'page_header']
class AcceptedRangeRecorded:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10903
    accept_time: int
    first_frame_uid: int
    last_frame_uid: int
    location_uid: int
    manifest_id: String[str[128]]
    manifest_uid: int
    schema_version: int
    since: int
    source_id: String[str[128]]
    source_uid: int
    status: ...
    until: int
    def __eq__(self, arg0: AcceptedRangeRecorded) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Band:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10308
    dest_id: int
    source_id: int
    def __eq__(self, arg0: Band) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class CacheReset:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10208
    carrier_type: int
    def __eq__(self, arg0: CacheReset) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Channel:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10305
    dest_id: int
    source_id: int
    def __eq__(self, arg0: Channel) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ChannelCursorUpdated:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10907
    channel_uid: int
    entry_count: int
    location_uid: int
    manifest_id: String[str[128]]
    manifest_uid: int
    range_since: String[str[40]]
    range_until: String[str[40]]
    schema_version: int
    source_head: String[str[128]]
    source_id: String[str[128]]
    source_uid: int
    sync_root_algo: String[str[16]]
    sync_root_value: String[str[72]]
    update_time: int
    def __eq__(self, arg0: ChannelCursorUpdated) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ChannelRequest:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10306
    dest_id: int
    source_id: int
    def __eq__(self, arg0: ChannelRequest) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Config:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10201
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    value: str
    def __eq__(self, arg0: Config) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Deregister:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10102
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Deregister) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class EpisodeClosed:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10805
    end_time: int
    episode_id: int
    frame_count: int
    last_frame_uid: int
    location_uid: int
    reason: String[str[64]]
    schema_version: int
    status: pykungfu.yijinjing.enums.EpisodeStatus
    def __eq__(self, arg0: EpisodeClosed) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class EpisodeFrameAttached:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10803
    carrier_type: int
    data_length: int
    dest: int
    episode_id: int
    frame_checksum: int
    frame_uid: int
    gen_time: int
    integrity_version: int
    location_uid: int
    payload_checksum: int
    schema_version: int
    source: int
    stream_id: int
    trigger_frame_uid: int
    trigger_time: int
    def __eq__(self, arg0: EpisodeFrameAttached) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class EpisodeHeartbeat:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10802
    episode_id: int
    frame_count: int
    last_frame_uid: int
    location_uid: int
    note: String[str[64]]
    schema_version: int
    update_time: int
    def __eq__(self, arg0: EpisodeHeartbeat) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class EpisodeOpen:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10801
    actor: String[str[64]]
    begin_time: int
    episode_id: int
    location_uid: int
    parent_episode_id: int
    root_trigger_frame_uid: int
    schema_version: int
    source: String[str[64]]
    title: String[str[64]]
    def __eq__(self, arg0: EpisodeOpen) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class EpisodeRefAttached:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10804
    episode_id: int
    location_uid: int
    ref_hash: String[str[128]]
    ref_id: String[str[128]]
    ref_kind: pykungfu.yijinjing.enums.EpisodeRefKind
    ref_uid: int
    schema_version: int
    update_time: int
    def __eq__(self, arg0: EpisodeRefAttached) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ExportBundleRecorded:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10906
    bundle_uid: int
    entry_count: int
    export_time: int
    exported_records: int
    location_uid: int
    manifest_id: String[str[128]]
    manifest_uid: int
    range_since: String[str[40]]
    range_until: String[str[40]]
    schema_version: int
    source_id: String[str[128]]
    source_uid: int
    sync_root_algo: String[str[16]]
    sync_root_value: String[str[72]]
    def __eq__(self, arg0: ExportBundleRecorded) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ImportManifestAccepted:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10904
    accept_time: int
    entries_byte_len: int
    entries_hash: String[str[72]]
    entry_count: int
    location_uid: int
    manifest_id: String[str[128]]
    manifest_uid: int
    range_since: String[str[40]]
    range_until: String[str[40]]
    schema_version: int
    scope: String[str[32]]
    source_coordinate: String[str[256]]
    source_head: String[str[128]]
    source_id: String[str[128]]
    source_type: String[str[32]]
    source_uid: int
    status: ...
    sync_root_algo: String[str[16]]
    sync_root_value: String[str[72]]
    def __eq__(self, arg0: ImportManifestAccepted) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Location:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10205
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Location) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ManifestEntryRecorded:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10905
    accept_time: int
    byte_len: int
    commitment_hash: String[str[72]]
    content_type: String[str[64]]
    entry_index: int
    entry_schema_version: int
    entry_source_id: String[str[128]]
    kind: String[str[64]]
    location_uid: int
    manifest_uid: int
    payload_hash: String[str[72]]
    payload_state: ...
    schema_version: int
    source_path: String[str[256]]
    source_time: String[str[40]]
    source_uid: int
    def __eq__(self, arg0: ManifestEntryRecorded) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OperatorStateUpdate:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10105
    info_a: str
    info_b: str
    location_uid: int
    state: pykungfu.yijinjing.enums.OperatorState
    update_time: int
    value: str
    def __eq__(self, arg0: OperatorStateUpdate) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OutputKey:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 701
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: OutputKey) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Register:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10101
    checkin_time: int
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    pid: int
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Register) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestCachedDone:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10209
    dest_id: int
    def __eq__(self, arg0: RequestCachedDone) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFrom:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10301
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFrom) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromOthers:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10309
    dest_id: int
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromOthers) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromPublic:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10302
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromPublic) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromSync:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10303
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromSync) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestWriteTo:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10304
    dest_id: int
    page_size: int
    def __eq__(self, arg0: RequestWriteTo) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestWriteToBand:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10307
    location_uid: int
    mode: pykungfu.yijinjing.enums.mode
    name: str
    namespace: str
    page_size: int
    role: pykungfu.yijinjing.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: RequestWriteToBand) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class SourceHeadUpdated:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10902
    first_frame_uid: int
    head: String[str[128]]
    inventory_hash: String[str[128]]
    inventory_hash_algo: String[str[16]]
    last_frame_uid: int
    location_uid: int
    schema_version: int
    since: int
    source_uid: int
    until: int
    update_time: int
    def __eq__(self, arg0: SourceHeadUpdated) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class SourceRegistered:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10901
    coordinate: String[str[256]]
    head: String[str[128]]
    kind: ...
    location_uid: int
    register_time: int
    schema_version: int
    source_id: String[str[128]]
    source_uid: int
    def __eq__(self, arg0: SourceRegistered) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class SyntheticData:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 601
    key: str
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: SyntheticData) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeKeyValue:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10602
    key: str
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: TimeKeyValue) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeRequest:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10501
    base_time: int
    duration: int
    id: int
    location_uid: int
    repeat: int
    def __eq__(self, arg0: TimeRequest) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeReset:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10502
    steady_clock_count: int
    system_clock_count: int
    def __eq__(self, arg0: TimeReset) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeValue:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10601
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: TimeValue) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class frame_header:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 0
    carrier_type: int
    data_type: pykungfu.yijinjing.enums.FrameDataType
    dest: int
    frame_uid: int
    gen_time: int
    header_length: int
    initial_source: int
    length: int
    source: int
    stream_id: int
    trigger_frame_uid: int
    trigger_time: int
    def __eq__(self, arg0: frame_header) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class page_header:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 1
    frame_header_length: int
    last_frame_position: int
    page_header_length: int
    page_size: int
    status: pykungfu.yijinjing.enums.PageStatus
    version: int
    def __eq__(self, arg0: page_header) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
