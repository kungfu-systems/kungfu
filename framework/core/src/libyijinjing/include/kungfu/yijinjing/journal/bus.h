#ifndef KUNGFU_BUS_H
#define KUNGFU_BUS_H
#include <condition_variable>
#include <kungfu/common.h>
namespace kungfu::yijinjing::journal {

class bus {
public:
  explicit bus(const bool on_load_page_required) : on_load_page_required_(on_load_page_required){};

  virtual ~bus() = default;

  void on_load_page();

  [[nodiscard]] bool is_on_load_page_required() const { return on_load_page_required_; }

  void notify_all();

  void wait();

  static void set_trigger_frame(const event_ptr &event);

  static void set_trigger_frame_uid(uint64_t frame_uid);

  static void set_trigger_source_id(uint32_t source_id);

  static void set_trigger_initial_source_id(uint32_t initial_source_id);

  static void set_trigger_dest_id(uint32_t dest_id);

  static void set_trigger_msg_type(int32_t msg_type);

  static uint64_t get_trigger_frame_uid();

  static uint32_t get_trigger_source_id();

  static uint32_t get_trigger_initial_source_id();

  static uint32_t get_trigger_dest_id();

  static int32_t get_trigger_msg_type();

private:
  std::condition_variable cv_{};
  std::mutex cv_mutex_{};
  bool ready_ = false;
  const bool on_load_page_required_;
  inline static thread_local uint64_t trigger_frame_uid_ = 0;
  inline static thread_local uint32_t trigger_source_id_ = 0;
  inline static thread_local uint32_t trigger_initial_source_id_ = 0;
  inline static thread_local uint32_t trigger_dest_id_ = 0;
  inline static thread_local int32_t trigger_msg_type_ = 0;
};

DECLARE_PTR(bus);
} // namespace kungfu::yijinjing::journal
#endif // KUNGFU_BUS_H