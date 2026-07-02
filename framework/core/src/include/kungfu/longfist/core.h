// SPDX-License-Identifier: Apache-2.0

//
// longfist-core: the schema leaf shared by libyijinjing and libkungfu.
//
// Holds ONLY the fact-ledger frame/page schema (frame_header, page_header) and
// the two enums the journal spine needs (FrameDataType, PageStatus). Business
// types (Order / Trade / Quote / ...) live in types.h / enums.h and are NOT
// visible here, so a pure journal core can include this leaf without pulling the
// trading schema.
//
// frame_header (tag 0) and page_header (tag 1) keep their type tags and field
// layout verbatim -- on-disk mmap journals stay byte-compatible.
//

#ifndef KUNGFU_LONGFIST_CORE_H
#define KUNGFU_LONGFIST_CORE_H

#include <fmt/ostream.h>
#include <nlohmann/json.hpp>
#include <spdlog/fmt/ostr.h>

#include <kungfu/common.h>

// Enum <-> json (de)serialization helper. Defined here (the schema leaf) so that
// both the core enums below and the business enums in enums.h can use it.
#define KF_JSON_SERIALIZE_ENUM(ENUM_TYPE, ...)                                                                         \
  template <typename BasicJsonType> inline void to_json(BasicJsonType &j, const ENUM_TYPE &e) {                        \
    static_assert(std::is_enum<ENUM_TYPE>::value, #ENUM_TYPE " must be an enum!");                                     \
    static const std::pair<ENUM_TYPE, BasicJsonType> m[] = __VA_ARGS__;                                                \
    auto it =                                                                                                          \
        std::find_if(std::begin(m), std::end(m),                                                                       \
                     [e](const std::pair<ENUM_TYPE, BasicJsonType> &ej_pair) -> bool { return ej_pair.first == e; });  \
    j = ((it != std::end(m)) ? it : std::begin(m))->second;                                                            \
  }                                                                                                                    \
  template <typename BasicJsonType> inline void from_json(const BasicJsonType &j, ENUM_TYPE &e) {                      \
    static_assert(std::is_enum<ENUM_TYPE>::value, #ENUM_TYPE " must be an enum!");                                     \
    static const std::pair<ENUM_TYPE, BasicJsonType> m[] = __VA_ARGS__;                                                \
    if (j.is_number()) {                                                                                               \
      e = static_cast<ENUM_TYPE>(j.template get<int8_t>());                                                            \
      return;                                                                                                          \
    }                                                                                                                  \
    auto it =                                                                                                          \
        std::find_if(std::begin(m), std::end(m), [&j](const std::pair<ENUM_TYPE, BasicJsonType> &ej_pair) -> bool {    \
          return ej_pair.second == j;                                                                                  \
        });                                                                                                            \
    e = ((it != std::end(m)) ? it : std::begin(m))->first;                                                             \
  }

namespace kungfu::longfist::enums {
// fmt 10 不再隐式格式化枚举；通过 ADL 友元 format_as 把本命名空间所有枚举
// 按底层整数格式化（与既有 operator<< 输出 int32_t 一致）。
template <typename E, std::enable_if_t<std::is_enum_v<E>, int> = 0> constexpr int32_t format_as(E e) {
  return static_cast<int32_t>(e);
}

enum class FrameDataType : int8_t { Raw, Json, Unknown };

KF_JSON_SERIALIZE_ENUM(FrameDataType, {
                                          {FrameDataType::Raw, "Raw"},
                                          {FrameDataType::Json, "Json"},
                                          {FrameDataType::Unknown, "Unknown"},
                                      })

inline std::ostream &operator<<(std::ostream &os, FrameDataType t) { return os << int32_t(t); }

inline bool operator==(int8_t type, FrameDataType t) { return type == int8_t(t); }

inline bool operator==(FrameDataType t, int8_t type) { return type == int8_t(t); }

enum class PageStatus : int8_t { Normal, PreOpen };

KF_JSON_SERIALIZE_ENUM(PageStatus, {
                                       {PageStatus::Normal, "Normal"},
                                       {PageStatus::PreOpen, "PreOpen"},
                                   })
} // namespace kungfu::longfist::enums

namespace kungfu::longfist::types {
KF_DEFINE_PACK_TYPE(                                           //
    frame_header, 0, PK(gen_time), TIMESTAMP(gen_time),        //
    /** total frame length (including header and data body);                //
     *  ADR-0001: serves as the frame publication token. Written last with   //
     *  std::atomic_ref release by the writer and read with acquire by the    //
     *  reader (see frame.h). NOT volatile: volatile gives no cross-thread    //
     *  ordering on weak-memory (ARM) targets. */                            //
    (uint32_t, length),                                        //
    /** header length */                                       //
    (uint32_t, header_length),                                 //
    /** generate time of the frame data */                     //
    (int64_t, gen_time),                                       //
    /** trigger time for this frame, use for latency stats */  //
    (int64_t, trigger_time),                                   //
    /** msg type of the data in frame (ADR-0001: no longer volatile;          //
     *  visibility is guaranteed by the length release/acquire token) */      //
    (int32_t, msg_type),                                       //
    /** source of this frame */                                //
    (uint32_t, source),                                        //
    /** dest of this frame */                                  //
    (uint32_t, dest),                                          //
    /** json or raw struct */                                  //
    (enums::FrameDataType, data_type),                         //
    /** the real writer of this frame */                       //
    (uint32_t, initial_source),                                //
    /** key of frame */                                        //
    (uint64_t, frame_uid),                                     //
    /** current_frame of reader when generate this frame */    //
    (uint64_t, trigger_frame_uid),                             //
    /** stream_id */                                           //
    (uint64_t, stream_id)                                      //
);

KF_DEFINE_PACK_TYPE(                          //
    page_header, 1, PK(version), PERPETUAL(), //
    (uint32_t, version),                      //
    (uint32_t, page_header_length),           //
    (uint64_t, page_size),                    //
    (uint32_t, frame_header_length),          //
    (longfist::enums::PageStatus, status),    // 0 close 1 preopen 2 open 3 flushing
    (uint64_t, last_frame_position)           //
);
} // namespace kungfu::longfist::types

#endif // KUNGFU_LONGFIST_CORE_H
