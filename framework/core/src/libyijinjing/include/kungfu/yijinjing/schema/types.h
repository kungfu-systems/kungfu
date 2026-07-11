// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_SCHEMA_TYPES_H
#define KUNGFU_YIJINJING_SCHEMA_TYPES_H

#include <kungfu/common.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu::yijinjing::enums {

enum class OperatorState : int8_t { Pending, DisConnected = 2, Connected = 3, Ready = 100 };

KF_JSON_SERIALIZE_ENUM(OperatorState, {
                                          {OperatorState::Pending, "Pending"},
                                          {OperatorState::DisConnected, "DisConnected"},
                                          {OperatorState::Connected, "Connected"},
                                          {OperatorState::Ready, "Ready"},
                                      })

inline std::ostream &operator<<(std::ostream &os, OperatorState t) { return os << int32_t(t); }

enum class HistoryDataType : int8_t { Normal, PageEnd, TotalEnd };

KF_JSON_SERIALIZE_ENUM(HistoryDataType, {
                                            {HistoryDataType::Normal, "Normal"},
                                            {HistoryDataType::PageEnd, "PageEnd"},
                                            {HistoryDataType::TotalEnd, "TotalEnd"},
                                        })

inline std::ostream &operator<<(std::ostream &os, HistoryDataType t) { return os << int32_t(t); }

enum class EpisodeStatus : int8_t { Open = 1, Ended = 2, Aborted = 3, Tombstoned = 4 };

KF_JSON_SERIALIZE_ENUM(EpisodeStatus, {
                                          {EpisodeStatus::Open, "Open"},
                                          {EpisodeStatus::Ended, "Ended"},
                                          {EpisodeStatus::Aborted, "Aborted"},
                                          {EpisodeStatus::Tombstoned, "Tombstoned"},
                                      })

inline std::ostream &operator<<(std::ostream &os, EpisodeStatus t) { return os << int32_t(t); }

enum class EpisodeRefKind : int8_t { InputFrame = 1, Payload = 2, Schema = 3, Episode = 4 };

KF_JSON_SERIALIZE_ENUM(EpisodeRefKind, {
                                           {EpisodeRefKind::InputFrame, "InputFrame"},
                                           {EpisodeRefKind::Payload, "Payload"},
                                           {EpisodeRefKind::Schema, "Schema"},
                                           {EpisodeRefKind::Episode, "Episode"},
                                       })

inline std::ostream &operator<<(std::ostream &os, EpisodeRefKind t) { return os << int32_t(t); }

enum class SourceKind : int8_t { Local = 1, ImportedBundle = 2, KungfuRuntime = 3, Adapter = 4 };

KF_JSON_SERIALIZE_ENUM(SourceKind, {
                                       {SourceKind::Local, "Local"},
                                       {SourceKind::ImportedBundle, "ImportedBundle"},
                                       {SourceKind::KungfuRuntime, "KungfuRuntime"},
                                       {SourceKind::Adapter, "Adapter"},
                                   })

inline std::ostream &operator<<(std::ostream &os, SourceKind t) { return os << int32_t(t); }

enum class SourceVerificationStatus : int8_t { Ok = 1, Degraded = 2, Failed = 3 };

KF_JSON_SERIALIZE_ENUM(SourceVerificationStatus, {
                                                     {SourceVerificationStatus::Ok, "Ok"},
                                                     {SourceVerificationStatus::Degraded, "Degraded"},
                                                     {SourceVerificationStatus::Failed, "Failed"},
                                                 })

inline std::ostream &operator<<(std::ostream &os, SourceVerificationStatus t) { return os << int32_t(t); }

enum class PayloadState : int8_t { Present = 1, Redacted = 2, Absent = 3, Missing = 4 };

KF_JSON_SERIALIZE_ENUM(PayloadState, {
                                         {PayloadState::Present, "Present"},
                                         {PayloadState::Redacted, "Redacted"},
                                         {PayloadState::Absent, "Absent"},
                                         {PayloadState::Missing, "Missing"},
                                     })

inline std::ostream &operator<<(std::ostream &os, PayloadState t) { return os << int32_t(t); }

} // namespace kungfu::yijinjing::enums

namespace kungfu::yijinjing::types {

KF_DEFINE_MARK_TYPE(Time, 10052);
KF_DEFINE_MARK_TYPE(Ping, 10053);
KF_DEFINE_MARK_TYPE(Pong, 10054);
KF_DEFINE_MARK_TYPE(RequestStart, 10153);
KF_DEFINE_MARK_TYPE(RequestStop, 10154);
KF_DEFINE_MARK_TYPE(RequestDeregister, 10155);
KF_DEFINE_MARK_TYPE(OperatorStateRequest, 10156);
KF_DEFINE_MARK_TYPE(CachedReadyToRead, 10251);
KF_DEFINE_MARK_TYPE(RequestCached, 10252);
KF_DEFINE_MARK_TYPE(CachedPause, 10253);
KF_DEFINE_MARK_TYPE(CachedResume, 10254);
KF_DEFINE_MARK_TYPE(SocketData, 10751);

KF_DEFINE_DATA_TYPE(                                     //
    SyntheticData, 601, PK(key), TIMESTAMP(update_time), //
    (int64_t, update_time),                              //
    (std::string, key),                                  //
    (std::string, tag_a),                                //
    (std::string, tag_b),                                //
    (std::string, tag_c),                                //
    (std::string, value)                                 //
);

KF_DEFINE_DATA_TYPE(                                          //
    OutputKey, 701, PK(location_uid), TIMESTAMP(update_time), //
    (uint64_t, uid64),                                        //
    (uint32_t, location_uid),                                 //
    (enums::location_role, role),                             //
    (enums::mode, mode),                                      //
    (std::string, namespace_),                                //
    (std::string, name),                                      //
    (uint32_t, seed)                                          //
);

KF_DEFINE_DATA_TYPE(                                //
    Register, 10101, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                              //
    (uint32_t, location_uid),                       //
    (enums::location_role, role),                   //
    (enums::mode, mode),                            //
    (std::string, namespace_),                      //
    (std::string, name),                            //
    (uint32_t, seed),                               //
    (int32_t, pid),                                 //
    (int64_t, checkin_time)                         //
);

KF_DEFINE_DATA_TYPE(                                  //
    Deregister, 10102, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                                //
    (uint32_t, location_uid),                         //
    (enums::location_role, role),                     //
    (enums::mode, mode),                              //
    (std::string, namespace_),                        //
    (std::string, name),                              //
    (uint32_t, seed)                                  //
);

KF_DEFINE_DATA_TYPE(                                                     //
    OperatorStateUpdate, 10105, PK(update_time), TIMESTAMP(update_time), //
    (enums::OperatorState, state),                                       //
    (int64_t, update_time),                                              //
    (uint32_t, location_uid),                                            //
    (std::string, info_a),                                               //
    (std::string, info_b),                                               //
    (std::string, value)                                                 //
);

KF_DEFINE_DATA_TYPE(                              //
    Config, 10201, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                            //
    (uint32_t, location_uid),                     //
    (enums::location_role, role),                 //
    (std::string, namespace_),                    //
    (std::string, name),                          //
    (uint32_t, seed),                             //
    (enums::mode, mode),                          //
    (std::string, value)                          //
);

KF_DEFINE_PACK_TYPE(                                  //
    CacheReset, 10208, PK(carrier_type), PERPETUAL(), //
    (int32_t, carrier_type)                           //
);

KF_DEFINE_PACK_TYPE(                                    //
    RequestCachedDone, 10209, PK(dest_id), PERPETUAL(), //
    (uint32_t, dest_id)                                 //
);

KF_DEFINE_PACK_TYPE(                                    //
    RequestReadFrom, 10301, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                              //
    (int64_t, from_time),                               //
    (uint64_t, page_size)                               //
);

KF_DEFINE_PACK_TYPE(                                          //
    RequestReadFromPublic, 10302, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                                    //
    (int64_t, from_time),                                     //
    (uint64_t, page_size)                                     //
);

KF_DEFINE_PACK_TYPE(                                        //
    RequestReadFromSync, 10303, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                                  //
    (int64_t, from_time),                                   //
    (uint64_t, page_size)                                   //
);

KF_DEFINE_PACK_TYPE(                                 //
    RequestWriteTo, 10304, PK(dest_id), PERPETUAL(), //
    (uint32_t, dest_id),                             //
    (uint64_t, page_size)                            //
);

KF_DEFINE_PACK_TYPE(                                     //
    Channel, 10305, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                               //
    (uint32_t, dest_id)                                  //
);

KF_DEFINE_PACK_TYPE(                                            //
    ChannelRequest, 10306, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                                      //
    (uint32_t, dest_id)                                         //
);

KF_DEFINE_DATA_TYPE(                                          //
    RequestWriteToBand, 10307, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                                        //
    (uint32_t, location_uid),                                 //
    (enums::location_role, role),                             //
    (enums::mode, mode),                                      //
    (std::string, namespace_),                                //
    (std::string, name),                                      //
    (uint32_t, seed),                                         //
    (uint64_t, page_size)                                     //
);

KF_DEFINE_PACK_TYPE(                                  //
    Band, 10308, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                            //
    (uint32_t, dest_id)                               //
);

KF_DEFINE_PACK_TYPE(                                           //
    EpisodeOpen, 10801, PK(episode_id), TIMESTAMP(begin_time), //
    (uint32_t, schema_version),                                //
    (uint64_t, episode_id),                                    //
    (uint64_t, parent_episode_id),                             //
    (uint64_t, root_trigger_frame_uid),                        //
    (uint32_t, location_uid),                                  //
    (int64_t, begin_time),                                     //
    (array<char, 64>, title),                                  //
    (array<char, 64>, actor),                                  //
    (array<char, 64>, source)                                  //
);

KF_DEFINE_PACK_TYPE(                                                              //
    EpisodeHeartbeat, 10802, PK(episode_id, update_time), TIMESTAMP(update_time), //
    (uint32_t, schema_version),                                                   //
    (uint64_t, episode_id),                                                       //
    (uint32_t, location_uid),                                                     //
    (int64_t, update_time),                                                       //
    (uint64_t, last_frame_uid),                                                   //
    (uint64_t, frame_count),                                                      //
    (array<char, 64>, note)                                                       //
);

KF_DEFINE_PACK_TYPE(                                                             //
    EpisodeFrameAttached, 10803, PK(episode_id, frame_uid), TIMESTAMP(gen_time), //
    (uint32_t, schema_version),                                                  //
    (uint64_t, episode_id),                                                      //
    (uint32_t, location_uid),                                                    //
    (uint64_t, frame_uid),                                                       //
    (uint64_t, trigger_frame_uid),                                               //
    (uint64_t, stream_id),                                                       //
    (int64_t, gen_time),                                                         //
    (int64_t, trigger_time),                                                     //
    (int32_t, carrier_type),                                                     //
    (uint32_t, source),                                                          //
    (uint32_t, dest),                                                            //
    (uint32_t, data_length),                                                     //
    (uint32_t, integrity_version),                                               //
    (uint64_t, payload_checksum),                                                //
    (uint64_t, frame_checksum)                                                   //
);

KF_DEFINE_PACK_TYPE(                                                                      //
    EpisodeRefAttached, 10804, PK(episode_id, ref_kind, ref_uid), TIMESTAMP(update_time), //
    (uint32_t, schema_version),                                                           //
    (uint64_t, episode_id),                                                               //
    (uint32_t, location_uid),                                                             //
    (enums::EpisodeRefKind, ref_kind),                                                    //
    (uint64_t, ref_uid),                                                                  //
    (int64_t, update_time),                                                               //
    (array<char, 128>, ref_id),                                                           //
    (array<char, 128>, ref_hash)                                                          //
);

KF_DEFINE_PACK_TYPE(                                           //
    EpisodeClosed, 10805, PK(episode_id), TIMESTAMP(end_time), //
    (uint32_t, schema_version),                                //
    (uint64_t, episode_id),                                    //
    (uint32_t, location_uid),                                  //
    (enums::EpisodeStatus, status),                            //
    (int64_t, end_time),                                       //
    (uint64_t, last_frame_uid),                                //
    (uint64_t, frame_count),                                   //
    (array<char, 64>, reason)                                  //
);

// ADR-0043: the sealed Episode's content identity — a hash root chained over
// the Episode's owned claim sequence, appended as the final claim after the
// seal. schema_version pins both the record layout and the root composition.
KF_DEFINE_PACK_TYPE(                                                     //
    EpisodeRootCommitted, 10806, PK(episode_id), TIMESTAMP(commit_time), //
    (uint32_t, schema_version),                                          //
    (uint64_t, episode_id),                                              //
    (uint32_t, location_uid),                                            //
    (int64_t, commit_time),                                              //
    (uint32_t, covered_record_count),                                    //
    (array<char, 16>, algorithm),                                        //
    (array<char, 72>, root_value)                                        //
);

// Storage source-registry records (ADR-0037): Hana-core kernel metadata for the
// ADR-0018 storage-service source family, written to an append-only yijinjing
// journal and folded into a current view. JSON is an edge projection only.
KF_DEFINE_PACK_TYPE(                                                   //
    SourceRegistered, 10901, PK(source_uid), TIMESTAMP(register_time), //
    (uint32_t, schema_version),                                        //
    (uint64_t, source_uid),                                            //
    (enums::SourceKind, kind),                                         //
    (uint32_t, location_uid),                                          //
    (int64_t, register_time),                                          //
    (array<char, 128>, source_id),                                     //
    (array<char, 256>, coordinate),                                    //
    (array<char, 128>, head)                                           //
);

KF_DEFINE_PACK_TYPE(                                                               //
    SourceHeadUpdated, 10902, PK(source_uid, update_time), TIMESTAMP(update_time), //
    (uint32_t, schema_version),                                                    //
    (uint64_t, source_uid),                                                        //
    (uint32_t, location_uid),                                                      //
    (int64_t, update_time),                                                        //
    (uint64_t, first_frame_uid),                                                   //
    (uint64_t, last_frame_uid),                                                    //
    (int64_t, since),                                                              //
    (int64_t, until),                                                              //
    (array<char, 128>, head),                                                      //
    (array<char, 16>, inventory_hash_algo),                                        //
    (array<char, 128>, inventory_hash)                                             //
);

KF_DEFINE_PACK_TYPE(                                                                    //
    AcceptedRangeRecorded, 10903, PK(source_uid, manifest_uid), TIMESTAMP(accept_time), //
    (uint32_t, schema_version),                                                         //
    (uint64_t, source_uid),                                                             //
    (uint64_t, manifest_uid),                                                           //
    (uint32_t, location_uid),                                                           //
    (int64_t, accept_time),                                                             //
    (uint64_t, first_frame_uid),                                                        //
    (uint64_t, last_frame_uid),                                                         //
    (int64_t, since),                                                                   //
    (int64_t, until),                                                                   //
    (enums::SourceVerificationStatus, status),                                          //
    (array<char, 128>, source_id),                                                      //
    (array<char, 128>, manifest_id)                                                     //
);

// Storage manifest-catalog records (ADR-0037, final slice): the ADR-0018
// import-manifest / export-bundle / channel-cursor family as Hana-core kernel
// metadata in an append-only yijinjing journal. Variable-length manifest
// entries grow as ManifestEntryRecorded delta records; the exact accepted
// entries document is committed by content hash (entries_hash) into the
// content store, so the JSON edge and the cross-store sync root stay
// byte-reproducible. JSON is an edge projection only, never the contract.
KF_DEFINE_PACK_TYPE(                                                         //
    ImportManifestAccepted, 10904, PK(manifest_uid), TIMESTAMP(accept_time), //
    (uint32_t, schema_version),                                              //
    (uint64_t, manifest_uid),                                                //
    (uint64_t, source_uid),                                                  //
    (uint32_t, location_uid),                                                //
    (int64_t, accept_time),                                                  //
    (uint64_t, entry_count),                                                 //
    (uint64_t, entries_byte_len),                                            //
    (enums::SourceVerificationStatus, status),                               //
    (array<char, 32>, scope),                                                //
    (array<char, 32>, source_type),                                          //
    (array<char, 128>, source_id),                                           //
    (array<char, 128>, manifest_id),                                         //
    (array<char, 128>, source_head),                                         //
    (array<char, 256>, source_coordinate),                                   //
    (array<char, 40>, range_since),                                          //
    (array<char, 40>, range_until),                                          //
    (array<char, 16>, sync_root_algo),                                       //
    (array<char, 72>, sync_root_value),                                      //
    (array<char, 72>, entries_hash)                                          //
);

KF_DEFINE_PACK_TYPE(                                                                     //
    ManifestEntryRecorded, 10905, PK(manifest_uid, entry_index), TIMESTAMP(accept_time), //
    (uint32_t, schema_version),                                                          //
    (uint64_t, manifest_uid),                                                            //
    (uint64_t, source_uid),                                                              //
    (uint64_t, entry_index),                                                             //
    (uint32_t, location_uid),                                                            //
    (int64_t, accept_time),                                                              //
    (uint32_t, entry_schema_version),                                                    //
    (uint64_t, byte_len),                                                                //
    (enums::PayloadState, payload_state),                                                //
    (array<char, 64>, kind),                                                             //
    (array<char, 128>, entry_source_id),                                                 //
    (array<char, 256>, source_path),                                                     //
    (array<char, 40>, source_time),                                                      //
    (array<char, 64>, content_type),                                                     //
    (array<char, 72>, payload_hash),                                                     //
    (array<char, 72>, commitment_hash)                                                   //
);

KF_DEFINE_PACK_TYPE(                                                                  //
    ExportBundleRecorded, 10906, PK(bundle_uid, export_time), TIMESTAMP(export_time), //
    (uint32_t, schema_version),                                                       //
    (uint64_t, bundle_uid),                                                           //
    (uint64_t, manifest_uid),                                                         //
    (uint64_t, source_uid),                                                           //
    (uint32_t, location_uid),                                                         //
    (int64_t, export_time),                                                           //
    (uint64_t, exported_records),                                                     //
    (uint64_t, entry_count),                                                          //
    (array<char, 128>, source_id),                                                    //
    (array<char, 128>, manifest_id),                                                  //
    (array<char, 40>, range_since),                                                   //
    (array<char, 40>, range_until),                                                   //
    (array<char, 16>, sync_root_algo),                                                //
    (array<char, 72>, sync_root_value)                                                //
);

KF_DEFINE_PACK_TYPE(                                                                   //
    ChannelCursorUpdated, 10907, PK(channel_uid, update_time), TIMESTAMP(update_time), //
    (uint32_t, schema_version),                                                        //
    (uint64_t, channel_uid),                                                           //
    (uint64_t, source_uid),                                                            //
    (uint64_t, manifest_uid),                                                          //
    (uint32_t, location_uid),                                                          //
    (int64_t, update_time),                                                            //
    (uint64_t, entry_count),                                                           //
    (array<char, 128>, source_id),                                                     //
    (array<char, 128>, manifest_id),                                                   //
    (array<char, 128>, source_head),                                                   //
    (array<char, 40>, range_since),                                                    //
    (array<char, 40>, range_until),                                                    //
    (array<char, 16>, sync_root_algo),                                                 //
    (array<char, 72>, sync_root_value)                                                 //
);

KF_DEFINE_PACK_TYPE(                                                   //
    RequestReadFromOthers, 10309, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                                             //
    (uint32_t, dest_id),                                               //
    (int64_t, from_time),                                              //
    (uint64_t, page_size)                                              //
);

KF_DEFINE_PACK_TYPE(                         //
    TimeRequest, 10501, PK(id), PERPETUAL(), //
    (int32_t, id),                           //
    (int64_t, base_time),                    //
    (int64_t, duration),                     //
    (int64_t, repeat),                       //
    (uint32_t, location_uid)                 //
);

KF_DEFINE_PACK_TYPE(                                                           //
    TimeReset, 10502, PK(system_clock_count, steady_clock_count), PERPETUAL(), //
    (int64_t, system_clock_count),                                             //
    (int64_t, steady_clock_count)                                              //
);

KF_DEFINE_DATA_TYPE(                                           //
    TimeValue, 10601, PK(update_time), TIMESTAMP(update_time), //
    (int64_t, update_time),                                    //
    (std::string, tag_a),                                      //
    (std::string, tag_b),                                      //
    (std::string, tag_c),                                      //
    (std::string, value)                                       //
);

KF_DEFINE_DATA_TYPE(                                      //
    TimeKeyValue, 10602, PK(key), TIMESTAMP(update_time), //
    (int64_t, update_time),                               //
    (std::string, key),                                   //
    (std::string, tag_a),                                 //
    (std::string, tag_b),                                 //
    (std::string, tag_c),                                 //
    (std::string, value)                                  //
);

} // namespace kungfu::yijinjing::types

#endif // KUNGFU_YIJINJING_SCHEMA_TYPES_H
