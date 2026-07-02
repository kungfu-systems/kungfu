// SPDX-License-Identifier: Apache-2.0
//
// Created by Keren Dong on 2019-06-10.
//

#include <kungfu/yijinjing/util/util.h>
// borrowed from <spdlog/details/os-inl.h> begin

#ifdef _WIN32

#ifndef NOMINMAX
#define NOMINMAX // prevent windows redefining min/max
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <io.h>      // _get_osfhandle and _isatty support
#include <process.h> //  _get_pid support
#include <windows.h>

#ifdef __MINGW32__
#include <share.h>
#endif

#if defined(SPDLOG_WCHAR_TO_UTF8_SUPPORT) || defined(SPDLOG_WCHAR_FILENAMES)
#include <limits>
#endif

#include <direct.h> // for _mkdir/_wmkdir

#else // unix

#include <fcntl.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/syscall.h> //Use gettid() syscall under linux to get thread id

#elif defined(_AIX)
#include <pthread.h> // for pthread_getthreadid_np

#elif defined(__DragonFly__) || defined(__FreeBSD__)
#include <pthread_np.h> // for pthread_getthreadid_np

#elif defined(__NetBSD__)
#include <lwp.h> // for _lwp_self

#elif defined(__sun)
#include <thread.h> // for thr_self
#endif

#endif // unix

bool is_terminal(FILE *file) noexcept {
#ifdef _WIN32
  return ::_isatty(_fileno(file)) != 0;
#else
  return ::isatty(fileno(file)) != 0;
#endif
}

bool is_color_terminal() noexcept {
#ifdef _WIN32
  return true;
#else
  static constexpr std::array<const char *, 14> Terms = {{"ansi", "color", "console", "cygwin", "gnome", "konsole",
                                                          "kterm", "linux", "msys", "putty", "rxvt", "screen", "vt100",
                                                          "xterm"}};

  const char *env_p = std::getenv("TERM");
  if (env_p == nullptr) {
    return false;
  }

  static const bool result = std::any_of(std::begin(Terms), std::end(Terms),
                                         [&](const char *term) { return std::strstr(env_p, term) != nullptr; });
  return result;
#endif
}

// Return current thread id as size_t
// It exists because the std::this_thread::get_id() is much slower(especially
// under VS 2013)
inline size_t _thread_id() noexcept {
#ifdef _WIN32
  return static_cast<size_t>(::GetCurrentThreadId());
#elif defined(__linux__)
#if defined(__ANDROID__) && defined(__ANDROID_API__) && (__ANDROID_API__ < 21)
#define SYS_gettid __NR_gettid
#endif
  return static_cast<size_t>(::syscall(SYS_gettid));
#elif defined(_AIX) || defined(__DragonFly__) || defined(__FreeBSD__)
  return static_cast<size_t>(::pthread_getthreadid_np());
#elif defined(__NetBSD__)
  return static_cast<size_t>(::_lwp_self());
#elif defined(__OpenBSD__)
  return static_cast<size_t>(::getthrid());
#elif defined(__sun)
  return static_cast<size_t>(::thr_self());
#elif __APPLE__
  uint64_t tid;
  pthread_threadid_np(nullptr, &tid);
  return static_cast<size_t>(tid);
#else // Default to standard C++11 (other Unix)
  return static_cast<size_t>(std::hash<std::thread::id>()(std::this_thread::get_id()));
#endif
}
// borrowed from <spdlog/details/os-inl.h> end

// borrowed from <spdlog/sinks/wincolor_sink-inl.h> begin
#ifdef _WINDOWS
#include <wincon.h>

class WinColor {
public:
  const WORD BOLD = FOREGROUND_INTENSITY;
  const WORD RED = FOREGROUND_RED;
  const WORD GREEN = FOREGROUND_GREEN;
  const WORD CYAN = FOREGROUND_GREEN | FOREGROUND_BLUE;
  const WORD WHITE = FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE;
  const WORD YELLOW = FOREGROUND_RED | FOREGROUND_GREEN;
  WinColor() {
    colors_["trace"] = WHITE;
    colors_["debug"] = CYAN;
    colors_["info"] = GREEN;
    colors_["warn"] = YELLOW | BOLD;
    colors_["warning"] = YELLOW | BOLD;
    colors_["error"] = RED | BOLD;
    colors_["critical"] = BACKGROUND_RED | WHITE | BOLD;
    colors_["off"] = 0;
  }
  void print(const std::string &level, const std::string &log) {
    HANDLE out_handle_ = ::GetStdHandle(STD_OUTPUT_HANDLE);
    WORD color_attribs = colors_[level];
    CONSOLE_SCREEN_BUFFER_INFO orig_buffer_info;
    ::GetConsoleScreenBufferInfo(out_handle_, &orig_buffer_info);
    WORD back_color = orig_buffer_info.wAttributes;
    // retrieve the current background color
    back_color &= static_cast<WORD>(~(FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE | FOREGROUND_INTENSITY));
    // keep the background color unchanged
    ::SetConsoleTextAttribute(out_handle_, color_attribs | back_color);
    auto start = log.c_str();
    auto end = log.c_str() + log.length();
    auto size = static_cast<DWORD>(end - start);
    ::WriteFile(out_handle_, start, size, nullptr, nullptr);
    ::SetConsoleTextAttribute(out_handle_, orig_buffer_info.wAttributes); // reset to orig colors
  }

private:
  std::unordered_map<std::string, WORD> colors_;
};
WinColor color_printer;
#else
struct UnixColor {
  void print(const std::string &level, const std::string &log) {}
};
UnixColor color_printer;
#endif
// borrowed from <spdlog/sinks/wincolor_sink-inl.h> end

namespace kungfu::yijinjing::util {
void color_print(const std::string &level, const std::string &log) { color_printer.print(level, log); }

bool in_color_terminal() { return is_terminal(stdout) && is_color_terminal(); }

size_t get_thread_id() {
  static thread_local const size_t tid = _thread_id();
  return tid;
}
} // namespace kungfu::yijinjing::util
