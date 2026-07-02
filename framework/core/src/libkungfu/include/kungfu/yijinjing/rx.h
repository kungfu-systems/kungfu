// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_RX_H
#define KUNGFU_YIJINJING_RX_H

#include <csignal>
#include <rxcpp/rx.hpp>

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/util/stacktrace.h>

namespace kungfu {
namespace rx {
using namespace rxcpp;
using namespace rxcpp::operators;
using namespace rxcpp::util;

static constexpr auto noop_event_handler = []() { return [](const event_ptr &event) {}; };

static constexpr auto error_handler_log = [](const std::string &subscriber_name) {
  return [=](const std::exception_ptr &e) {
    try {
      std::rethrow_exception(e);
    } catch (const std::exception &ex) {
      SPDLOG_ERROR("subscriber {} got error: {}", subscriber_name, ex.what());
    }
  };
};

static constexpr auto complete_handler_log = [](const std::string &subscriber_name) {
  return [=]() { SPDLOG_DEBUG("subscriber {} completed", subscriber_name); };
};

template <typename EventType>
static constexpr auto instanceof
    = []() { return filter([](const event_ptr &event) { return dynamic_cast<EventType *>(event.get()) != nullptr; }); };

static constexpr auto is_custom_event = [](const event_ptr &event) -> bool {
  return event->msg_type() > 0 and longfist::AllTypesTags.find(event->msg_type()) == longfist::AllTypesTags.end();
};

static constexpr auto is_custom = []() {
  return filter([](const event_ptr &event) { return is_custom_event(event); });
};

template <typename... Ts>
static constexpr auto event_filter_any = [](auto member) {
  return [=](Ts... arg) {
    using T = std::invoke_result_t<decltype(member), event *>;
    type_check<T, Ts...>(arg...);
    auto args = boost::hana::make_tuple(arg...);
    return filter([=](const event_ptr &event) {
      auto check = [&](auto a) { return ((*event).*member)() == a; };
      return boost::hana::fold(boost::hana::transform(args, check), std::logical_or<>());
    });
  };
};

template <typename... Ts>
static constexpr auto lambda_filter_any = [](auto member) {
  return [=](Ts... arg) {
    using T = std::invoke_result_t<decltype(member), event *>;
    type_check<T, Ts...>(arg...);
    auto args = boost::hana::make_tuple(arg...);
    return [=](const event_ptr &event) {
      auto check = [&](auto a) { return ((*event).*member)() == a; };
      return boost::hana::fold(boost::hana::transform(args, check), std::logical_or<>());
    };
  };
};

template <typename... Ts> constexpr decltype(auto) is(Ts... arg) {
  return event_filter_any<Ts...>(&event::msg_type)(arg...);
}

template <typename... Ts> constexpr decltype(auto) while_is(Ts... arg) {
  return lambda_filter_any<Ts...>(&event::msg_type)(arg...);
}

template <typename... Ts> constexpr decltype(auto) from(Ts... arg) {
  return event_filter_any<Ts...>(&event::source)(arg...);
}

template <typename... Ts> constexpr decltype(auto) while_from(Ts... arg) {
  return lambda_filter_any<Ts...>(&event::source)(arg...);
}

template <typename... Ts> constexpr decltype(auto) to(Ts... arg) {
  return event_filter_any<Ts...>(&event::dest)(arg...);
}

template <typename... Ts> constexpr decltype(auto) while_to(Ts... arg) {
  return lambda_filter_any<Ts...>(&event::dest)(arg...);
}

static constexpr auto interrupt_on_error = [](const std::exception_ptr &e) {
  try {
    std::rethrow_exception(e);
  } catch (const rx::empty_error &ex) {
    SPDLOG_WARN("{}", ex.what());
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("Unexpected exception {} by rx:subscriber {}", typeid(ex).name(), ex.what());
    yijinjing::util::print_stack_trace();
  }
  raise(SIGINT);
};

template <class Arg>
static constexpr auto $(Arg an) -> decltype(subscribe<event_ptr>(std::forward<Arg>(an), interrupt_on_error)) {
  return subscribe<event_ptr>(std::forward<Arg>(an), interrupt_on_error);
}

template <class... ArgN>
static constexpr auto $(ArgN &&...an) -> decltype(subscribe<event_ptr>(std::forward<ArgN>(an)...)) {
  return subscribe<event_ptr>(std::forward<ArgN>(an)...);
}

template <class T, class Observable, class Subject> struct steppable : public operator_base<T> {
  typedef decay_t<Observable> source_type;
  typedef decay_t<Subject> subject_type;

  struct steppable_state : public std::enable_shared_from_this<steppable_state> {
    steppable_state(source_type o, subject_type sub) : source(std::move(o)), subject_value(std::move(sub)) {}

    source_type source;
    subject_type subject_value;
    rxu::detail::maybe<typename composite_subscription::weak_subscription> connection;
  };

  std::shared_ptr<steppable_state> state;

  steppable(source_type o, subject_type sub) : state(std::make_shared<steppable_state>(std::move(o), std::move(sub))) {}

  template <class Subscriber> void on_subscribe(Subscriber &&o) const {
    state->subject_value.get_observable().subscribe(std::forward<Subscriber>(o));
  }

  void on_connect(composite_subscription cs) const {
    auto destination = state->subject_value.get_subscriber();
    if (state->connection.empty()) {

      // the lifetime of each connect is nested in the subject lifetime
      state->connection.reset(destination.add(cs));

      auto localState = state;

      // when the connection is finished it should shut down the connection
      cs.add([destination, localState]() {
        if (!localState->connection.empty()) {
          destination.remove(localState->connection.get());
          localState->connection.reset();
        }
      });
    }
    // use cs not destination for lifetime of subscribe.
    state->source.subscribe(cs, destination);
  }
};

template <class Observable = rx::observable<event_ptr>, class SourceValue = rx::util::value_type_t<Observable>,
          class Subject = rx::subjects::subject<SourceValue>,
          class Steppable = rx::steppable<SourceValue, rx::util::decay_t<Observable>, Subject>,
          class Result = rx::connectable_observable<SourceValue, Steppable>>
std::function<Result(Observable)> holdon() {
  return [&](Observable ob) { return Result(Steppable(ob, Subject(rx::composite_subscription()))); };
}
} // namespace rx
} // namespace kungfu

#define $$(handler) kungfu::rx::$([&](const kungfu::event_ptr &event) { handler; })

#endif // KUNGFU_YIJINJING_RX_H
