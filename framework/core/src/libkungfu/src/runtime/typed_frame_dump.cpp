// SPDX-License-Identifier: Apache-2.0

// Runtime side of the frame typed-dump seam: yijinjing core renders only header
// + json payloads in frame::to_string(); this installs a dumper for the current
// core yijinjing schema registry.

#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/schema/registry.h>

namespace core_journal = kungfu::yijinjing::journal;

namespace kungfu::runtime::journal {

void install_typed_frame_dumper() {
  core_journal::frame::type_dumper() = [](const core_journal::frame &self, nlohmann::json &j) {
    hana::for_each(yijinjing::AllTypes, [&](auto pair) {
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

} // namespace kungfu::runtime::journal
