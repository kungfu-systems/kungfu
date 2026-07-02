// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/25.
//

#include <fstream>
#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/tracer.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>
#include <tabulate/table.hpp>

#define TIME_FORMAT "%T.%N"

using namespace tabulate;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::yijinjing {
struct console_table {
  Table table = {};
  int32_t width;
  int32_t height;
  bool show;
  int rows_count;

  console_table(int32_t console_width, int32_t console_height, bool is_show = false)
      : width(console_width), height(console_height), show(is_show), rows_count(0) {
    if (!is_show) {
      table.add_row({"gen_time", "trigger_time", "source", "dest", "msg_type", "data"});
    } else {
      table.add_row({"gen_time", "trigger_time", "source", "dest", "msg_type", "frame_length", "data_length"});
    }
    rows_count = 1;
  }

  ~console_table() {
    if (rows_count > 1) {
      print();
    }
  }

  void reset() {
    table = {};
    rows_count = 0;
  }

  void print() {
    table.format().padding(0).border(" ").hide_border().show_border_right();
    table.column(0).format().width(20).font_align(FontAlign::left);
    table.column(1).format().width(20).font_align(FontAlign::left);
    table.column(2).format().width(30).font_align(FontAlign::left);
    table.column(3).format().width(30).font_align(FontAlign::left);
    table.column(4).format().width(24).font_align(FontAlign::left);
    if (show) {
      table.column(5).format().width(24).font_align(FontAlign::left);
    } else if (width > 130) {
      table.column(5).format().width(width - 130);
    }
    std::cout << table << std::endl;
  }

  void add_row(const std::vector<std::variant<std::string, const char *, Table>> &cells) {
    table.add_row(cells);
    rows_count++;

    if (rows_count >= height) {
      print();
      reset();
    }
  }
};

io_device_console::io_device_console(data::location_ptr home, int32_t console_width, int32_t console_height)
    : io_device(std::move(home), false, true), console_width_(console_width), console_height_(console_height) {}

void io_device_console::trace(int64_t begin_time, int64_t end_time, bool in, bool out, std::string csv) {
  SPDLOG_INFO("trace begin_time {} end_time {}", begin_time, end_time);
  auto tracer = std::make_shared<yijinjing::journal::tracer>(home_, in, out, begin_time, end_time);
  auto &locations = tracer->get_all_locations();

  console_table table(console_width_, console_height_);
  std::ofstream of_csv;
  if (!csv.empty()) {
    of_csv.open(csv, std::ofstream::out | std::ofstream::trunc);
    of_csv << "gen_time"
           << ","
           << "trigger_time"
           << ","
           << "source"
           << ","
           << "dest"
           << ","
           << "msg_type"
           << ","
           << "frame_length"
           << ","
           << "data_length" << std::endl;
  }

  while (tracer->data_available()) {
    auto frame = tracer->current_frame();
    auto dest_name = frame->dest() == location::PUBLIC ? "public"
                     : location::SYNC                  ? "sync"
                                                       : locations.at(frame->dest())->uname;
    bool type_found = false;
    boost::hana::for_each(AllTypes, [&](auto type) {
      using DataType = typename decltype(+boost::hana::second(type))::type;
      if (frame->msg_type() == DataType::tag) {
        table.add_row({
            time::strftime(frame->gen_time(), TIME_FORMAT),     //
            time::strftime(frame->trigger_time(), TIME_FORMAT), //
            locations.at(frame->source())->uname,               //
            dest_name,                                          //
            DataType::type_name.c_str(),                        //
            frame->data<DataType>().to_string()                 //
        });

        if (!csv.empty()) {
          of_csv << time::strftime(frame->gen_time(), TIME_FORMAT) << ","
                 << time::strftime(frame->trigger_time(), TIME_FORMAT) << "," << locations.at(frame->source())->uname
                 << "," << dest_name << "," << DataType::type_name.c_str() << "," << frame->frame_length() << ","
                 << frame->data<DataType>().to_string() << std::endl;
        }
        type_found = true;
      }
    });

    if (not type_found) {
      auto location_uname = tracer->current_page()->get_location()->uname;
      auto dest_id = tracer->current_page()->get_dest_id();
      SPDLOG_WARN("{}/{:08x} msg_type {} not found", location_uname, dest_id, frame->msg_type());
    }

    tracer->next();
  }

  if (!csv.empty()) {
    of_csv.close();
  }
}

void io_device_console::show(int64_t begin_time, int64_t end_time, bool in, bool out, std::string csv) {
  SPDLOG_INFO("show begin_time {} end_time {}", begin_time, end_time);
  auto tracer = std::make_shared<yijinjing::journal::tracer>(home_, in, out, begin_time, end_time);
  auto &locations = tracer->get_all_locations();

  console_table table(console_width_, console_height_, true);
  std::ofstream of_csv;
  if (!csv.empty()) {
    of_csv.open(csv, std::ofstream::out | std::ofstream::trunc);
    of_csv << "gen_time"
           << ","
           << "trigger_time"
           << ","
           << "source"
           << ","
           << "dest"
           << ","
           << "msg_type"
           << ","
           << "data" << std::endl;
  }

  while (tracer->data_available()) {
    auto frame = tracer->current_frame();
    auto dest_name = frame->dest() == location::PUBLIC ? "public"
                     : location::SYNC                  ? "sync"
                                                       : locations.at(frame->dest())->uname;
    bool type_found = false;
    boost::hana::for_each(AllTypes, [&](auto type) {
      using DataType = typename decltype(+boost::hana::second(type))::type;
      if (frame->msg_type() == DataType::tag) {
        table.add_row({
            time::strftime(frame->gen_time(), TIME_FORMAT),     //
            time::strftime(frame->trigger_time(), TIME_FORMAT), //
            locations.at(frame->source())->uname,               //
            dest_name,                                          //
            DataType::type_name.c_str(),                        //
            std::to_string(frame->frame_length()),              //
            std::to_string(frame->data_length())                //
        });
        if (!csv.empty()) {
          of_csv << time::strftime(frame->gen_time(), TIME_FORMAT) << ","
                 << time::strftime(frame->trigger_time(), TIME_FORMAT) << "," << locations.at(frame->source())->uname
                 << "," << dest_name << "," << DataType::type_name.c_str() << "," << frame->frame_length() << ","
                 << frame->data_length() << std::endl;
        }
        type_found = true;
      }
    });

    if (not type_found) {
      auto location_uname = tracer->current_page()->get_location()->uname;
      auto dest_id = tracer->current_page()->get_dest_id();
      SPDLOG_WARN("{}/{:08x} msg_type {} not found", location_uname, dest_id, frame->msg_type());
    }

    tracer->next();
  }

  if (!csv.empty()) {
    of_csv.close();
  }
}
} // namespace kungfu::yijinjing