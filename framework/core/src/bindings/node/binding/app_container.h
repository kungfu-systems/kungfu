// SPDX-License-Identifier: Apache-2.0
//
// Node binding for the Windows AppContainer guest launcher (ADR-0014): exposes
// libyijinjing's os::spawn_app_container to JS as `spawnAppContainer(spec)`,
// returning an AppContainerProcess with pid, wait() (a Promise) and kill(). The
// host-side glue (framework/api guest-windows.ts) owns the named pipes and turns
// this into the WindowsSandboxSpawn kungfu-guest expects.

#ifndef KUNGFU_NODE_APP_CONTAINER_H
#define KUNGFU_NODE_APP_CONTAINER_H

#include <napi.h>

namespace kungfu::node {
void InitAppContainer(Napi::Env env, Napi::Object exports);
} // namespace kungfu::node

#endif // KUNGFU_NODE_APP_CONTAINER_H
