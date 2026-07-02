// SPDX-License-Identifier: Apache-2.0
//
// born-FB Position 写侧构造器(Order/Trade 同法第三类型,推广到 state 类型):把 longfist POD Position 全字段按
// char-array/enum 表示口径(2026-06-21)序列化成 born-FB Position 载荷(FB 编码),供生产 producer(ledger/book)在
// feature flag 下 write_raw 到 journal,与 POD Position(tag 103)并存。
// 口径:array<char,N> -> FB string(到首 NUL,对齐 sqlite_orm text_printer);
//      enum class X:int8_t -> FB enum X:byte(镜像 enums.h,值=底层 int8,经 int8_t 中转 cast)。
// 字段全镜像 longfist::types::Position(types.h:175-216),字段名/列对齐既有 sqlite_orm。读侧 fb_projector 反射投影(R3)。
// enum InstrumentType 经 position_generated.h -> order_generated.h 复用;Direction/LedgerCategory 为 position 专属。
#ifndef KUNGFU_LONGFIST_FB_POSITION_FB_BUILDER_H
#define KUNGFU_LONGFIST_FB_POSITION_FB_BUILDER_H

#include <kungfu/longfist/fb/position_generated.h>
#include <kungfu/longfist/types.h>

#include <flatbuffers/flatbuffers.h>

#include <cstdint>
#include <string>

namespace kungfu::longfist::fb {

// born-FB Position 迁移 msg_type(>0,区分 POD Position longfist tag 103,迁移期并存)。
static constexpr int32_t POSITION_FB_TAG = 30103;

// 把 POD Position 全字段构造成 born-FB Position 载荷;返回 FB 字节,可直接 write_raw。
inline std::string build_fb_position(const kungfu::longfist::types::Position &p) {
  flatbuffers::FlatBufferBuilder fbb;
  // 口径:array<char,N> -> FB string(先建 Offset)。
  auto inst = fbb.CreateString(p.instrument_id.to_string());
  auto exch = fbb.CreateString(p.exchange_id.to_string());
  // 口径:enum class:int8_t -> FB enum:byte(经 int8_t 中转,值镜像 enums.h)。CreatePosition 参数顺序=table 字段声明序。
  auto root = CreatePosition(fbb, p.update_time, inst,
                             static_cast<InstrumentType>(static_cast<int8_t>(p.instrument_type)), exch, p.holder_uid,
                             static_cast<LedgerCategory>(static_cast<int8_t>(p.ledger_category)),
                             static_cast<Direction>(static_cast<int8_t>(p.direction)), p.volume, p.yesterday_volume,
                             p.frozen_total, p.frozen_yesterday, p.static_yesterday, p.open_volume, p.last_price,
                             p.avg_open_price, p.position_cost_price, p.avg_open_price_today, p.close_price,
                             p.pre_close_price, p.settlement_price, p.pre_settlement_price, p.margin, p.position_pnl,
                             p.close_pnl, p.realized_pnl, p.unrealized_pnl, p.source_id, p.source_op_id);
  fbb.Finish(root);
  return std::string(reinterpret_cast<const char *>(fbb.GetBufferPointer()), fbb.GetSize());
}

} // namespace kungfu::longfist::fb
#endif // KUNGFU_LONGFIST_FB_POSITION_FB_BUILDER_H
