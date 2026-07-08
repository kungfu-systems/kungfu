// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-10.
//

#include <csignal>
#include <cstdio>
#include <kungfu/common.h>
#include <kungfu/yijinjing/practice/hero.h>
#include <kungfu/yijinjing/util/stacktrace.h>

using namespace kungfu::yijinjing::util;

namespace kungfu::yijinjing::os {
static practice::hero *hero_instance = {};
static bool signals_handler_enabled = true;

void stop_hero() {
  if (hero_instance != nullptr && hero_instance->is_live()) {
    hero_instance->signal_stop();
  }
}

void exit_hero(int signum) {
  if (hero_instance != nullptr && hero_instance->is_live()) {
    hero_instance->signal_stop();
    hero_instance->on_exit();
  }
  exit(signum);
}

void kf_os_signal_handler(int signum) {
  switch (signum) {
#ifdef _WINDOWS
  case SIGINT:   // interrupt
  case SIGBREAK: // Ctrl-Break sequence
    KF_LOG_INFO("kungfu app interrupted");
    stop_hero();
    break;
  case SIGTERM: // Software termination signal from kill
    KF_LOG_INFO("kungfu app terminated");
    stop_hero();
    break;
  case SIGILL:         // illegal instruction - invalid function image
  case SIGFPE:         // floating point exception
  case SIGSEGV:        // segment violation
  case SIGABRT:        // abnormal termination triggered by abort call
  case SIGABRT_COMPAT: // SIGABRT compatible with other platforms, same as SIGABRT
    // Fatal crash path: do NOT call KF_LOG_* (spdlog) here -- it allocates and
    // locks and can deadlock or double-fault before we reach the dumper. The
    // real symbolized dump comes from the SEH __except (hero.cpp) and the
    // top-level filter installed in handle_os_signals(); this contextless
    // CRT-signal path is only a last resort.
    print_stack_trace(nullptr);
    exit_hero(signum);
    break;
#else
  case SIGURG:   // discard signal       urgent condition present on socket
  case SIGCONT:  // discard signal       continue after stop
  case SIGCHLD:  // discard signal       child status has changed
  case SIGIO:    // discard signal       I/O is possible on a descriptor (see fcntl(2))
  case SIGWINCH: // discard signal       Window size change
    KF_LOG_INFO("kungfu app discard signal {}", signum);
    break;
  case SIGSTOP: // stop process         stop (cannot be caught or ignored)
  case SIGTSTP: // stop process         stop signal generated from keyboard
  case SIGTTIN: // stop process         background read attempted from control terminal
  case SIGTTOU: // stop process         background write attempted to control terminal
    KF_LOG_CRITICAL("kungfu app stopped by signal {}", signum);
    exit_hero(signum);
    break;
  case SIGINT: // terminate process    interrupt program
    KF_LOG_INFO("kungfu app interrupted");
    exit_hero(signum);
    break;
  case SIGTERM: // terminate process    software termination signal
    KF_LOG_INFO("kungfu app terminated");
    stop_hero();
    break;
  case SIGKILL: // terminate process    kill program
    KF_LOG_INFO("kungfu app killed");
    exit_hero(signum);
  case SIGHUP:    // terminate process    terminal line hangup
  case SIGPIPE:   // terminate process    write on a pipe with no reader
  case SIGALRM:   // terminate process    real-time timer expired
  case SIGXCPU:   // terminate process    cpu time limit exceeded (see setrlimit(2))
  case SIGXFSZ:   // terminate process    file size limit exceeded (see setrlimit(2))
  case SIGVTALRM: // terminate process    virtual time alarm (see setitimer(2))
  case SIGPROF:   // terminate process    profiling timer alarm (see setitimer(2))
    // Fatal crash path: do NOT call KF_LOG_* (spdlog) here. It allocates and
    // locks and can deadlock or double-fault before we reach the dumper,
    // especially after heap corruption. print_stack_trace() is async-signal-safe
    // and emits the signal number itself.
    print_stack_trace(stderr, signum);
    exit_hero(signum);
  case SIGUSR1: // terminate process    User defined signal 1
  case SIGUSR2: // terminate process    User defined signal 2
    print_stack_trace(stderr, signum);
    exit_hero(signum);
  case SIGQUIT: // create core image    quit program
  case SIGILL:  // create core image    illegal instruction
  case SIGTRAP: // create core image    trace trap
  case SIGABRT: // create core image    abort program (formerly SIGIOT)
  case SIGFPE:  // create core image    floating-point exception
  case SIGBUS:  // create core image    bus error
    print_stack_trace(stderr, signum);
    exit_hero(signum);
  case SIGSEGV: // create core image    segmentation violation
    print_stack_trace(stderr, signum);
    exit_hero(signum);
  case SIGSYS: // create core image    non-existent system call invoked
    print_stack_trace(stderr, signum);
    exit_hero(signum);
#endif // _WINDOWS
#ifdef __APPLE__
  case SIGINFO: // discard signal       status request from keyboard
    KF_LOG_INFO("kungfu app discard signal {}", signum);
    break;
  case SIGEMT: // create core image    emulate instruction executed
    print_stack_trace(stderr, signum);
    exit_hero(signum);
#endif // __APPLE__
  default:
    KF_LOG_INFO("kungfu app caught unknown signal {}, signal ignored", signum);
  }
}

void disable_os_signals_handler() { signals_handler_enabled = false; }

#ifdef _WINDOWS
// Process-wide backstop for exceptions raised outside hero::produce's SEH frame
// (other threads, or before / after the produce loop). It hands the dumper real
// EXCEPTION_POINTERS, unlike the contextless CRT signal(SIGSEGV) path.
static LONG WINAPI kf_top_level_filter(EXCEPTION_POINTERS *ep) {
  print_stack_trace(ep);
  return EXCEPTION_EXECUTE_HANDLER;
}
#endif // _WINDOWS

void handle_os_signals(void *hero) {
  if (hero_instance != nullptr) {
    throw yijinjing_error("kungfu can only have one hero instance per process");
  }

  hero_instance = static_cast<practice::hero *>(hero);

  if (not signals_handler_enabled) {
    KF_LOG_WARN("OS signals hander disabled");
    return;
  }

  // Warm up the crash dumper once, outside any signal context, so the in-handler
  // path never triggers lazy dynamic-linker / dbghelp initialization.
  prepare_stack_trace();

#ifdef _WINDOWS
  // Install the process-wide backstop after warm-up so the filter path only does
  // symbol lookups, never first-time DbgHelp initialization.
  SetUnhandledExceptionFilter(kf_top_level_filter);
#endif // _WINDOWS

  for (int s = 1; s < NSIG; s++) {
    signal(s, kf_os_signal_handler);
  }
}

void reset_hero_instance() { hero_instance = nullptr; }

} // namespace kungfu::yijinjing::os
