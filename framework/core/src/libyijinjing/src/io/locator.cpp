// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2021/5/21.
//

#include <algorithm>
#include <cstdlib>
#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <regex>
#include <unordered_set>

namespace kungfu::yijinjing::data {

namespace fs = std::filesystem;
namespace es = longfist::enums;

fs::path get_default_root() {
  char *kf_home = std::getenv("KF_HOME");
  if (kf_home != nullptr) {
    return fs::path{kf_home};
  }
#ifdef _WINDOWS
  auto appdata = std::getenv("APPDATA");
  auto root = fs::path(appdata);
#elif __APPLE__
  auto user_home = std::getenv("HOME");
  auto root = fs::path(user_home) / "Library" / "Application Support";
#elif __linux__
  auto user_home = std::getenv("HOME");
  auto root = fs::path(user_home) / ".config";
#endif // _WINDOWS
  return root / "kungfu" / "home";
}

std::string get_runtime_dir() {
  auto runtime_dir = std::getenv("KF_RUNTIME_DIR");
  if (runtime_dir != nullptr) {
    return runtime_dir;
  }
  return (get_default_root() / "runtime").string();
}

std::string get_root_dir(es::mode m, const std::vector<std::string> &tags) {
  static const std::unordered_map<es::mode, std::pair<std::string, std::string>> map_env = {
      {es::mode::LIVE, std::pair("KF_RUNTIME_DIR", "runtime")},
      {es::mode::BACKTEST, std::pair("KF_BACKTEST_DIR", "backtest")},
      {es::mode::DATA, std::pair("KF_DATASET_DIR", "dataset")},
      {es::mode::REPLAY, std::pair("KF_REPLAY_DIR", "replay")},
  };

  auto iter = map_env.find(m);
  if (iter == map_env.end()) {
    SPDLOG_WARN("unrecognized mode: {}, init root_ as mode::LIVE", m);
    return get_runtime_dir();
  } else {
    auto dir_path = std::getenv(iter->second.first.c_str());
    if (dir_path != nullptr) {
      return dir_path;
    }
    auto home_dir_path = get_default_root() / iter->second.second;
    home_dir_path /= std::accumulate(tags.begin(), tags.end(), fs::path{},
                                     [](const fs::path &p, const std::string &tag) { return p / tag; });
    return home_dir_path.string();
  }
}

locator::locator(const std::string &root, es::mode m)
    : root_(root), dir_mode_(m), locator_uid(util::hash_str_32(root)) {}

locator::locator(const std::string &root) : locator(root, es::mode::LIVE) {}

locator::locator() : locator(get_runtime_dir(), es::mode::LIVE) {}

locator::locator(es::mode m, const std::vector<std::string> &tags) : locator(get_root_dir(m, tags)) {}

bool locator::has_env(const std::string &name) const { return std::getenv(name.c_str()) != nullptr; }

std::string locator::get_env(const std::string &name) const { return std::getenv(name.c_str()); }

std::string locator::layout_directory(longfist::enums::layout layout, longfist::enums::category c, const std::string &g,
                                      const std::string &n, longfist::enums::mode m, bool create_not_exist) const {
  auto dir = root_ /                       //
             es::get_layout_name(layout) / //
             es::get_category_name(c) /    //
             g /                           //
             n /                           //
             es::get_mode_name(m);
  if (create_not_exist && not fs::exists(dir)) {
    fs::create_directories(dir);
  }
  return dir.string();
}

std::string locator::layout_dir(const location_ptr &location, es::layout layout, bool create_not_exist) const {
  return layout_directory(layout, location->category, location->group, location->name, location->mode,
                          create_not_exist);
}

std::string locator::layout_file(const location_ptr &location, es::layout layout, const std::string &name) const {
  auto path = fs::path(layout_dir(location, layout)) / fmt::format("{}.{}", name, es::get_layout_name(layout));
  return path.string();
}

std::string locator::default_to_system_db(const location_ptr &location, const std::string &name) const {
  auto sqlite_layout = es::layout::SQLITE;
  auto db_file = layout_file(location, sqlite_layout, name);
  if (not fs::exists(db_file)) {
    auto system_db_file = root_ /                                     //
                          es::get_layout_name(sqlite_layout) /        //
                          es::get_category_name(location->category) / //
                          location->group /                           //
                          location->name /                            //
                          es::get_mode_name(location->mode);
    fs::copy(system_db_file, db_file);
  }
  return db_file;
}

std::vector<uint32_t> locator::list_page_id(const location_ptr &location, uint32_t dest_id) const {
  std::vector<uint32_t> result = {};
  auto dest_id_str = fmt::format("{:08x}", dest_id);
  auto dir = fs::path(layout_dir(location, es::layout::JOURNAL, false));
  if (not fs::exists(dir)) {
    return {};
  }
  for (auto &it : fs::recursive_directory_iterator(dir)) {
    auto basename = it.path().stem();
    if (it.is_regular_file() and it.path().extension() == ".journal" and basename.stem() == dest_id_str) {
      auto index = std::atoi(basename.extension().string().c_str() + 1);
      result.push_back(index);
    }
  }
  std::sort(result.begin(), result.end());
  return result;
}

static constexpr auto lambda_w = [](const std::string &pattern) { return pattern == "*" ? ".*" : pattern; };

static constexpr auto lambda_g = [](const std::string &pattern) { return fmt::format("({})", lambda_w(pattern)); };

std::vector<location_ptr> locator::list_locations(const std::string &category, const std::string &group,
                                                  const std::string &name, const std::string &mode) const {
  fs::path search_path = root_ / ".*" / lambda_g(category) / lambda_g(group) / lambda_g(name) / lambda_g(mode);
  std::string pattern = std::regex_replace(search_path.string(), std::regex("\\\\"), "\\\\");
  std::regex search_regex(pattern);
  std::unordered_map<uint32_t, location_ptr> avoid_repeat_locations = {};
  std::vector<location_ptr> result = {};
  std::smatch match;
  for (auto &it : fs::recursive_directory_iterator(root_)) {
    auto path = it.path().string();
    if (it.is_directory() and std::regex_match(path, match, search_regex)) {
      // sometimes bad locations existed, like self log writtern by broker in cwd folder, we need to avoid them
      std::string mode_name = match[4].str();
      auto mode_local = es::get_mode_by_name(mode_name);
      if (mode_local == es::mode::LIVE and mode_name != "live") {
        continue;
      }
      std::string category_name = match[1].str();
      auto category_local = es::get_category_by_name(category_name);
      if (category_local == es::category::SYSTEM and category_name != "system") {
        continue;
      }
      auto l = location::make_shared(mode_local,     //
                                     category_local, //
                                     match[2].str(), //
                                     match[3].str(), //
                                     std::make_shared<locator>(root_.string()));
      if (avoid_repeat_locations.find(l->uid) == avoid_repeat_locations.end()) {
        avoid_repeat_locations.emplace(l->uid, l);
        result.push_back(l);
      }
    }
  }
  return result;
}

std::vector<uint32_t> locator::list_location_dest(const location_ptr &location) const {
  std::unordered_set<uint32_t> set = {};
  auto dir = fs::path(layout_dir(location, es::layout::JOURNAL, false));
  if (not fs::exists(dir)) {
    return {};
  }
  for (auto &it : fs::recursive_directory_iterator(dir)) {
    auto basename = it.path().stem();
    if (it.is_regular_file() and it.path().extension() == ".journal") {
      try {
        set.emplace(std::stoul(basename.stem(), nullptr, 16));
      } catch (const std::exception &ex) {
        SPDLOG_ERROR("failed to std::stoul(basename.stem(), nullptr, 16) {}", basename);
      }
    }
  }
  return std::vector<uint32_t>{set.begin(), set.end()};
}

std::vector<uint32_t> locator::list_location_dest_by_db(const location_ptr &location) const {
  std::unordered_set<uint32_t> set = {};
  auto dir = fs::path(layout_dir(location, es::layout::SQLITE));
  if (not fs::exists(dir)) {
    return {};
  }
  for (auto &it : fs::recursive_directory_iterator(dir)) {
    auto basename = it.path().stem();
    if (it.is_regular_file() and it.path().extension() == ".db") {
      try {
        set.emplace(std::stoul(basename.stem(), nullptr, 16));
      } catch (const std::exception &ex) {
        SPDLOG_ERROR("failed to std::stoul(basename.stem(), nullptr, 16) {}", basename);
      }
    }
  }
  return std::vector<uint32_t>{set.begin(), set.end()};
}

bool locator::operator==(const locator &another) const {
  return dir_mode_ == another.dir_mode_ and root_.string() == another.root_.string();
}

location::location(longfist::enums::mode m, longfist::enums::category c, std::string g, std::string n, locator_ptr l,
                   uint32_t default_seed)
    : locator(std::move(l)), uname(fmt::format("{}/{}/{}/{}", longfist::enums::get_category_name(c), g, n,
                                               longfist::enums::get_mode_name(m))) {
  uid64 = util::hash_str_64(uname);
  category = c;
  group = std::move(g);
  name = std::move(n);
  mode = m;
  seed = default_seed == 0 ? KUNGFU_HASH_SEED : default_seed;
  uid = util::hash_str_32(uname, seed);
  location_uid = uid;
  verify_location_uid();
}

bool location::is_verify_location() {
  static bool is_verify = std::getenv("KF_VERIFY_LOCATION") != nullptr;
  return is_verify;
}

void location::verify_location_uid() {
  if (not is_verify_location()) {
    return;
  }
  const std::string rocksdb_seed = get_master_kv(uname);
  SPDLOG_TRACE("rocksdb_seed: {}", rocksdb_seed);
  if (not rocksdb_seed.empty()) {
    update_seed(std::stoul(rocksdb_seed));
    return;
  }
  while (is_uid_clash()) {
    SPDLOG_TRACE("Location: {}", this->to_string());
  }
}

bool location::is_uid_clash() {
  std::string str_location_uid64;
  const std::string clash_uname = get_master_kv(std::to_string(uid));
  if (clash_uname.empty() or clash_uname == uname) {
    return false;
  } else {
    SPDLOG_TRACE("clash_uname: {}, uname: {} , same uid: {}", clash_uname, uname, uid);
    update_seed(uid);
    return true;
  }
}

std::string location::get_master_kv(const std::string &key) {
  auto provider = master_kv();
  return provider ? provider(*this, key) : std::string{};
}

void location::update_seed(uint32_t s) {
  seed = s;
  uid = util::hash_str_32(uname, seed);
  location_uid = uid;
  SPDLOG_TRACE("{}", this->to_string());
}
} // namespace kungfu::yijinjing::data