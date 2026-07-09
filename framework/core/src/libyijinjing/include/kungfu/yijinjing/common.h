// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_COMMON_H
#define KUNGFU_YIJINJING_COMMON_H

#include <cstdarg>
#include <filesystem>

#include <kungfu/common.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu {
namespace yijinjing {

/** size related */
constexpr int KB = 1024;
constexpr int MB = KB * KB;

/** publish flag for core-side publisher interface;
 * mirrors NNG_FLAG_NONBLOCK so core headers need no nng dependency
 * (value welded by static_assert in nanomsg/socket.h) */
constexpr int PUBLISH_NONBLOCK = 2;

class yijinjing_error : public std::runtime_error {
public:
  explicit yijinjing_error(const std::string &message) : runtime_error(message) { SPDLOG_CRITICAL(message); }
};

class resource {
public:
  virtual bool is_usable() = 0;

  virtual bool setup() = 0;

  virtual ~resource() = default;
};

class publisher : public resource {
public:
  ~publisher() override = default;

  virtual int notify() = 0;

  virtual int publish(const std::string &json_message, int flags = PUBLISH_NONBLOCK, bool no_exception = false) = 0;
};

DECLARE_PTR(publisher)

class observer : public resource {
public:
  ~observer() override = default;

  virtual bool wait() = 0;

  virtual bool nonblock_wait() = 0;

  [[nodiscard]] virtual int get_recv_timeout() const = 0;

  virtual const std::string &get_notice() = 0;
};

DECLARE_PTR(observer)

namespace data {
FORWARD_DECLARE_STRUCT_PTR(location)

FORWARD_DECLARE_CLASS_PTR(locator)
typedef std::unordered_map<uint32_t, location_ptr> location_map;

class locator {
public:
  explicit locator();

  explicit locator(const std::string &root, yijinjing::enums::mode m);

  explicit locator(yijinjing::enums::mode m, const std::vector<std::string> &tag = {});

  explicit locator(const std::string &root);

  virtual ~locator() = default;

  [[nodiscard]] virtual bool has_env(const std::string &name) const;

  [[nodiscard]] virtual std::string get_env(const std::string &name) const;

  [[nodiscard]] virtual std::string layout_dir(const location_ptr &location, yijinjing::enums::layout layout,
                                               bool create_not_exist = true) const;

  [[nodiscard]] std::string layout_directory(yijinjing::enums::layout layout, yijinjing::enums::location_role c,
                                             const std::string &namespace_, const std::string &n,
                                             yijinjing::enums::mode m, bool create_not_exist = true) const;

  [[nodiscard]] virtual std::string layout_file(const location_ptr &location, yijinjing::enums::layout layout,
                                                const std::string &name) const;

  [[nodiscard]] virtual std::string default_to_system_db(const location_ptr &location, const std::string &name) const;

  [[nodiscard]] virtual std::vector<uint32_t> list_page_id(const location_ptr &location, uint32_t dest_id) const;

  [[nodiscard]] virtual std::vector<location_ptr> list_locations(const std::string &role, const std::string &namespace_,
                                                                 const std::string &name,
                                                                 const std::string &mode) const;

  [[nodiscard]] virtual std::vector<uint32_t> list_location_dest(const location_ptr &location) const;

  [[nodiscard]] virtual std::vector<uint32_t> list_location_dest_by_db(const location_ptr &location) const;

  [[nodiscard]] yijinjing::enums::mode get_dir_mode() const { return dir_mode_; }

  [[nodiscard]] std::string get_root() const { return root_.string(); }

  bool operator==(const locator &another) const;

  const std::filesystem::path root_;
  const yijinjing::enums::mode dir_mode_;
  const uint32_t locator_uid;
};

struct location : public std::enable_shared_from_this<location>, public yijinjing::types::Location {
  static constexpr uint32_t PUBLIC = 0;
  static constexpr uint32_t SYNC = 1;

  // uid-seed verification reads the master's kv map, whose storage backend
  // belongs to the runtime. The runtime installs a provider here (see
  // install_master_kv_provider in util/rocks.h); without one, get_master_kv
  // returns empty and verification degrades to the pure hash path.
  using master_kv_provider = std::string (*)(const location &self, const std::string &key);

  static master_kv_provider &master_kv() {
    static master_kv_provider provider = nullptr;
    return provider;
  }

  const locator_ptr locator;
  const std::string uname;
  uint32_t uid;

  location(yijinjing::enums::mode m, yijinjing::enums::location_role c, std::string namespace_, std::string n,
           locator_ptr l, uint32_t default_seed = KUNGFU_HASH_SEED);

  bool static is_verify_location();

  bool is_uid_clash();

  void verify_location_uid();

  std::string get_master_kv(const std::string &key);

  void update_seed(uint32_t s);

  template <typename T> inline T to() const {
    T t{};
    t.uid64 = uid64;
    t.location_uid = location_uid;
    t.mode = mode;
    t.role = role;
    t.namespace_ = namespace_;
    t.name = name;
    t.seed = seed;
    return t;
  }

  template <typename T> inline T &to(T &t) const {
    t.uid64 = uid64;
    t.location_uid = location_uid;
    t.mode = mode;
    t.role = role;
    t.namespace_ = namespace_;
    t.name = name;
    t.seed = seed;
    return t;
  }

  template <typename T> static inline location_ptr make_shared(T msg, locator_ptr l) {
    return std::make_shared<location>(msg.mode, msg.role, msg.namespace_, msg.name, l, msg.seed);
  }

  static inline location_ptr make_shared(yijinjing::enums::mode m, yijinjing::enums::location_role c,
                                         const std::string &namespace_, const std::string &n, const locator_ptr &l,
                                         uint32_t default_seed = KUNGFU_HASH_SEED) {
    return std::make_shared<location>(m, c, namespace_, n, l, default_seed);
  }
  bool operator==(const location &another) const {
    return locator->get_root() == another.locator->get_root() and role == another.role and
           namespace_ == another.namespace_ and name == another.name and mode == another.mode;
  }
};
} // namespace data
} // namespace yijinjing
} // namespace kungfu

namespace std {
template <> struct hash<kungfu::yijinjing::data::location> {
  std::size_t operator()(const kungfu::yijinjing::data::location &l) const {
    return (static_cast<uint64_t>(kungfu::yijinjing::fast_hash_str_32(l.locator->get_root())) << 32) ^
           static_cast<uint32_t>(l.uid);
  }
};
} // namespace std

namespace kungfu {
namespace hana {
using namespace boost::hana;

template <typename T> nlohmann::json to_json(T &obj) {
  nlohmann::json j{};
  hana::for_each(hana::accessors<T>(), [&](auto t) {
    auto name = hana::first(t);
    j[public_field_name(name.c_str())] = hana::second(t)(obj);
  });
  return j;
}
} // namespace hana
} // namespace kungfu

#endif // KUNGFU_YIJINJING_COMMON_H
