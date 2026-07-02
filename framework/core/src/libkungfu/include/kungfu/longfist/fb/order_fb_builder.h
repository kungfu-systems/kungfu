// SPDX-License-Identifier: Apache-2.0
//
// born-FB Order 写侧构造器:把 longfist POD Order 全字段按 char-array/enum 表示口径(2026-06-21)序列化成
// born-FB Order 载荷(FB 编码),供生产 producer 在 feature flag 下 write_raw 到 journal,与 POD Order(tag 202)并存。
// 口径:array<char,N> -> FB string(到首 NUL,对齐 sqlite_orm text_printer);
//      enum class X:int8_t -> FB enum X:byte(镜像 enums.h,值=底层 int8,经 int8_t 中转 cast)。
// 字段全镜像 longfist::types::Order(types.h:266-302),字段名/列对齐既有 sqlite_orm。读侧 fb_projector 反射投影(R3)。
#ifndef KUNGFU_LONGFIST_FB_ORDER_FB_BUILDER_H
#define KUNGFU_LONGFIST_FB_ORDER_FB_BUILDER_H

#include <kungfu/longfist/fb/order_generated.h>
#include <kungfu/longfist/types.h>

#include <flatbuffers/flatbuffers.h>

#include <cstdint>
#include <string>

namespace kungfu::longfist::fb {

// born-FB Order 迁移 msg_type(>0,区分 POD Order longfist tag 202,迁移期并存)。
static constexpr int32_t ORDER_FB_TAG = 30202;

// 把 POD Order 全字段构造成 born-FB Order 载荷;返回 FB 字节,可直接 write_raw。
inline std::string build_fb_order(const kungfu::longfist::types::Order &o) {
  flatbuffers::FlatBufferBuilder fbb;
  // 口径:array<char,N> -> FB string(先建 Offset)。
  auto ext = fbb.CreateString(o.external_order_id.to_string());
  auto tday = fbb.CreateString(o.trading_day.to_string());
  auto inst = fbb.CreateString(o.instrument_id.to_string());
  auto exch = fbb.CreateString(o.exchange_id.to_string());
  auto contract = fbb.CreateString(o.contract_id.to_string());
  auto emsg = fbb.CreateString(o.error_msg.to_string());
  // 口径:enum class:int8_t -> FB enum:byte(经 int8_t 中转,值镜像 enums.h)。
  auto root = CreateOrder(fbb, o.order_id, ext, o.parent_id, o.insert_time, o.update_time, o.restore_time, tday, inst,
                          exch, contract, static_cast<InstrumentType>(static_cast<int8_t>(o.instrument_type)),
                          o.limit_price, o.frozen_price, o.volume, o.volume_left, o.tax, o.commission,
                          static_cast<OrderStatus>(static_cast<int8_t>(o.status)), o.error_id, emsg, o.is_swap,
                          static_cast<Side>(static_cast<int8_t>(o.side)),
                          static_cast<Offset>(static_cast<int8_t>(o.offset)),
                          static_cast<HedgeFlag>(static_cast<int8_t>(o.hedge_flag)),
                          static_cast<PriceType>(static_cast<int8_t>(o.price_type)),
                          static_cast<VolumeCondition>(static_cast<int8_t>(o.volume_condition)),
                          static_cast<TimeCondition>(static_cast<int8_t>(o.time_condition)));
  fbb.Finish(root);
  return std::string(reinterpret_cast<const char *>(fbb.GetBufferPointer()), fbb.GetSize());
}

} // namespace kungfu::longfist::fb
#endif // KUNGFU_LONGFIST_FB_ORDER_FB_BUILDER_H
