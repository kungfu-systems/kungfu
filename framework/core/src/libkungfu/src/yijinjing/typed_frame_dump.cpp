// SPDX-License-Identifier: Apache-2.0

// Runtime side of the frame typed-dump seam: yijinjing core renders only header
// + json payloads in frame::to_string(); this installs a dumper for the current
// core longfist registry.

#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/journal/frame.h>

namespace kungfu::yijinjing::journal {

void install_typed_frame_dumper() {
  frame::type_dumper() = [](const frame &self, nlohmann::json &j) {
    hana::for_each(longfist::AllTypes, [&](auto pair) {
      using DataType = typename decltype(+hana::second(pair))::type;
      if (DataType::tag == self.carrier_type()) {
        j["data"] = self.data<DataType>().to_string();
      }
    });
  };
}

static const bool typed_frame_dumper_installed = [] {
  install_typed_frame_dumper();
  return true;
}();

} // namespace kungfu::yijinjing::journal
