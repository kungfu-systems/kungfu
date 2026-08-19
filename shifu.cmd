@echo off
rem shifu.cmd - kungfu dev/build launcher (Windows).
rem ASCII-only on purpose: Windows cmd parses .cmd in the OEM codepage (e.g. GBK/936),
rem so non-ASCII bytes corrupt parsing. Keep this file ASCII; the sh version may use UTF-8.
rem
rem == PROTOCOL WARNING (KF-ADR-019f86da-4f90-7626-861e-3fdee887abd2) ==============================================
rem This file's NAME and LOCATION (repo root) are a welded surface baked into
rem every installed shifu binary in the wild: together with ./shifu it is how
rem they recognize a checkout and what they spawn (via cmd.exe) when
rem delegating. Never rename, move, or remove it. Its implementation may
rem change freely, but any dispatch of a resolved native binary must keep
rem setting SHIFU_FROM_SHIM=1.
rem See docs/adr/KF-ADR-019f86da-4f90-7626-861e-3fdee887abd2.md
rem =============================================================================
rem
rem Aligns with the macOS/Linux shifu (sh):
rem   shifu app | shifu build:core | shifu <any pnpm task>
rem   shifu cache / docs / gate / proxy / config   rich subcommands -> delegated to L2 node (not pnpm)
rem
rem This script is a thin shim in front of the native launcher (crates\shifu,
rem a self-contained Rust binary -- see docs/development/rust-adoption.md). Resolution order:
rem   1. SHIFU_BIN            explicit binary override
rem   2. dev machines (cargo + git) -> source-fresh cache slot
rem                                    ...\kungfu\shifu\<version>-<launcher-src-sha>\,
rem                                    rebuilt whenever the launcher source moves, so a
rem                                    checkout always runs its own code, not the last release
rem   3. user-global cached binary  %USERPROFILE%\.cache\kungfu\shifu\<version>\
rem   4. fnm + uv already installed -> proven in-script bootstrap below
rem                                    (force native instead with SHIFU_NATIVE=1)
rem   5. fresh machine              -> download the prebuilt binary pinned by
rem                                    crates\shifu\Cargo.toml (SHIFU_DIST_MIRROR
rem                                    overrides the base URL), or cargo build from source
rem The native launcher bootstraps fnm + uv itself when missing (prebuilt binaries),
rem and loads the MSVC environment when cl.exe is absent. The in-script bootstrap
rem kept below still requires the two one-time prerequisites:
rem fnm (winget install Schniz.fnm) + uv (winget install astral-sh.uv).
rem
rem Repo has zero LAN/mirror coupling (open-source clone uses official upstreams). For LAN cache /
rem CN mirror, use `shifu config` to derive build-local.env.example into the user-global file:
rem   %USERPROFILE%\.config\kungfu\build-local.env  (sh-format, shared by main repo and all worktrees)
rem This .cmd parses that file with pure cmd to load mirror env; optional repo .\build-local.env overrides.
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Load local cache proxy config: user-global first, then optional in-repo override (set propagates to children).
rem Explicit Buildchain/runner cache projection wins over local development config.
set "_KFC_EXPLICIT_CACHE_REF=%SHIFU_CACHE_PROFILE_REF%"
set "_KFC_EXPLICIT_CACHE_DIGEST=%SHIFU_CACHE_PROFILE_DIGEST%"
set "_KFC_EXPLICIT_CACHE_SCOPE=%SHIFU_CACHE_SCOPE%"
set "_KFC_USERCFG=%USERPROFILE%\.config\kungfu\build-local.env"
if defined XDG_CONFIG_HOME set "_KFC_USERCFG=%XDG_CONFIG_HOME%\kungfu\build-local.env"
if "%SHIFU_CACHE_ACTIVE%"=="1" goto proxyloaded
rem Keep this inline: cmd.exe can lose a trailing batch label when the shim is
rem entered recursively through Node's shell mode, leaking an otherwise benign
rem "cannot find the batch label" diagnostic into strict child protocols.
for %%f in ("%_KFC_USERCFG%" ".\build-local.env") do if exist "%%~f" (
  for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"export " "%%~f"`) do (
    set "_kfc_k=%%a"
    set "_kfc_v=%%b"
    set "_kfc_k=!_kfc_k:export =!"
    set "_kfc_v=!_kfc_v:'=!"
    set "!_kfc_k!=!_kfc_v!"
  )
)
set "_kfc_k="
set "_kfc_v="
:proxyloaded
if defined _KFC_EXPLICIT_CACHE_REF set "SHIFU_CACHE_PROFILE_REF=%_KFC_EXPLICIT_CACHE_REF%"
if defined _KFC_EXPLICIT_CACHE_DIGEST set "SHIFU_CACHE_PROFILE_DIGEST=%_KFC_EXPLICIT_CACHE_DIGEST%"
if defined _KFC_EXPLICIT_CACHE_SCOPE set "SHIFU_CACHE_SCOPE=%_KFC_EXPLICIT_CACHE_SCOPE%"

rem Mark the canonical entrypoint and keep native dispatches from re-delegating here.
set "SHIFU_FROM_SHIM=1"
set "SHIFU_ENTRYPOINT=1"

rem Cache profiles are checkout-owned L2 contracts. Resolve/apply them before
rem native dispatch; an inner `shifu <task>` can still select the native path.
rem Native-only callers need the launcher to pin SHIFU_BIN before the cache
rem projection spawns its child. Keep the historical direct-Node cache path
rem for ordinary script-mode development.
if /i "%~1"=="cache" if "%SHIFU_NATIVE%"=="1" goto native
if /i "%~1"=="cache" goto delegate
if /i "%~1"=="check:source" goto sourceacceptance
if /i "%~1"=="project-cut" goto projectcut
if /i "%~1"=="action" goto action
if /i "%~1"=="work" goto assignment
if /i "%~1"=="kungfu" goto kungfucli
if /i "%~1"=="xinfa" goto xinfarun
if /i "%~1"=="xinfa:build" goto xinfa
if /i "%~1"=="xinfa:check" goto xinfa
if /i "%~1"=="xinfa:fix" goto xinfa
if /i "%~1"=="xinfa:standalone" goto xinfa
if /i "%~1"=="xinfa:quality" goto xinfaquality
if /i "%~1"=="core:architecture" goto readonlynode
if /i "%~1"=="core:architecture:health" goto readonlynode
if /i "%~1"=="invariant:verify" if /i "%~2"=="--list" goto readonlynode
if /i "%~1"=="invariant:verify" if /i "%~2"=="--" if /i "%~3"=="--list" goto readonlynode
if /i "%~1"=="maintainability:complexity" goto readonlynode
if /i "%~1"=="maintainability:amplification" goto readonlynode
if /i "%~1"=="kfd" if /i "%~2"=="status" goto readonlynode & if /i "%~1"=="kfd" if /i "%~2"=="query" goto readonlynode & if /i "%~1"=="kfd" if /i "%~2"=="check" goto readonlynode & if /i "%~1"=="kfd:query" goto readonlynode & if /i "%~1"=="kfd:support-matrix:check" goto readonlynode & if /i "%~1"=="maintainability:function-risk" goto readonlynode & if /i "%~1"=="maintainability:python-structure" goto readonlynode & if /i "%~1"=="maintainability:query" goto readonlynode & if /i "%~1"=="work-design:preflight" goto readonlynode & if /i "%~1"=="work-design:feedback" goto readonlynode
if /i "%~1"=="docs:check:readonly" goto docsreadonly
if /i "%~1"=="adr:release:gate" goto adrrelease
goto projectcut

:xinfaquality
if /i not "%~1"=="xinfa:quality" goto projectcut
set "_XINFA_QUALITY_MODE=--check"
if "%~2"=="" goto xinfaqualityrun
if /i "%~2"=="--check" goto xinfaqualityargs
if /i "%~2"=="--write" (
  set "_XINFA_QUALITY_MODE=--write"
  goto xinfaqualityargs
)
echo shifu: usage: shifu.cmd xinfa:quality [--check^|--write] 1>&2
exit /b 1

:xinfaqualityargs
if not "%~3"=="" (
  echo shifu: usage: shifu.cmd xinfa:quality [--check^|--write] 1>&2
  exit /b 1
)

:xinfaqualityrun
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0scripts\qualify-xinfa-context-quality.mjs" "%_XINFA_QUALITY_MODE%"
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0scripts\qualify-xinfa-context-quality.mjs" "%_XINFA_QUALITY_MODE%"
  exit /b !errorlevel!
)
echo shifu: xinfa quality qualification needs node 1>&2
exit /b 127

:projectcut
if /i not "%~1"=="project-cut" goto sourceacceptance
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0scripts\run-project-cut-entry.mjs" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0scripts\run-project-cut-entry.mjs" %*
  exit /b !errorlevel!
)
echo shifu: project-cut needs node 1>&2
exit /b 127

:action
set "KUNGFU_ACTION_HOST=development-node"
set "KUNGFU_ACTION_LAYOUT=source"
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  rem Keep the leading action token; action.mjs drops it without cmd re-expansion.
  fnm exec -- node "%~dp0framework\action\action.mjs" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0framework\action\action.mjs" %*
  exit /b !errorlevel!
)
echo shifu: action needs node 1>&2
exit /b 127

:assignment
set "_KFC_WORK_ARGS=%*" & set "_KFC_WORK_ARGS=!_KFC_WORK_ARGS:* =!"
if /i "%~2"=="capture" goto assignmentcapture & if /i "%~2"=="cleanup" goto assignmentcapture
ver >nul & if not exist "%~dp0framework\core\dist\kungfu\pykungfu*.pyd" if exist "%~dp0framework\assignment-capture\qualified-assignment-core-consumer.mjs" where node >nul 2>nul && node "%~dp0framework\assignment-capture\qualified-assignment-core-consumer.mjs" materialize --repository-root "%~dp0."
if !errorlevel! equ 127 exit /b 127
set "_KFC_UV=" & for /f "delims=" %%u in ('where uv 2^>nul') do if not defined _KFC_UV set "_KFC_UV=%%u"
if not defined _KFC_UV if exist "%~dp0framework\assignment-capture\qualified-assignment-core-consumer.mjs" where node >nul 2>nul && for /f "usebackq delims=" %%u in (`node "%~dp0framework\assignment-capture\qualified-assignment-core-consumer.mjs" resolve-cached-tool uv 2^>nul`) do if not defined _KFC_UV set "_KFC_UV=%%u"
if exist "%~dp0framework\core\dist\kungfu\pykungfu*.pyd" (
  if exist "%~dp0framework\core\dist\kungfu\kungfubuildinfo.json" (
    if defined _KFC_UV (
      pushd "%~dp0framework\core"
      "!_KFC_UV!" run --frozen python .devtools\kungfu_cli.py work !_KFC_WORK_ARGS!
      set "_KFC_WORK_ERROR=!errorlevel!"
      popd & exit /b !_KFC_WORK_ERROR!
    )
  )
)
echo {"schema":"kungfu.assignment-orchestration.diagnosis/v1","ok":false,"code":"assignment-current-checkout-binding-missing","message":"Assignment admission requires pykungfu from the current checkout","next_actions":[{"action":"build-core","command":"shifu.cmd build:core","description":"Assemble pykungfu from the current checkout"}]}
exit /b 127

:assignmentcapture
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0framework\assignment-capture\assignment-capture.mjs" !_KFC_WORK_ARGS!
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0framework\assignment-capture\assignment-capture.mjs" !_KFC_WORK_ARGS!
  exit /b !errorlevel!
)
echo shifu: work capture needs node 1>&2
exit /b 127
:sourceacceptance
rem shifu-cache-entry: source-acceptance-bypass
if /i not "%~1"=="check:source" goto native
set "SHIFU_CACHE_BYPASS=source-acceptance"
shift
node "%~dp0scripts\source-acceptance.mjs" %*
exit /b !errorlevel!

:readonlynode
node "%~dp0scripts\shifu-readonly-entry.mjs" %* || if errorlevel 9009 (echo {"schema":"shifu.readonly-bootstrap-diagnosis/v1","ok":false,"code":"readonly-node-unavailable","message":"The build-free read-only query requires an existing Node executable; Shifu will not install or repair dependencies from a read-only route.","nextActions":[]} ^& exit /b 127)
exit /b !errorlevel!

:kungfucli
shift
if exist "%~dp0framework\core\dist\kungfu\kungfu.exe" (
  if not defined KUNGFU_TUI_ENTRY if exist "%~dp0framework\tui\dist\tui.mjs" set "KUNGFU_TUI_ENTRY=%~dp0framework\tui\dist\tui.mjs" & if not defined KF_BUNDLED_EXTENSION_ROOT if exist "%~dp0extensions\agent-work-lab\experience\starter-project.json" set "KF_BUNDLED_EXTENSION_ROOT=%~dp0extensions" & "%~dp0framework\core\dist\kungfu\kungfu.exe" %*
  exit /b !errorlevel!
)
echo shifu: kungfu source CLI is not assembled; run shifu.cmd build:core 1>&2
exit /b 127

:xinfarun
rem shifu-xinfa-source-entry: hash-pinned-wasm-with-native-fallback
set "_XINFA_FORWARD_ARGS="
if not "%~2"=="" (
  set "_XINFA_FORWARD_ARGS=%*"
  set "_XINFA_FORWARD_ARGS=!_XINFA_FORWARD_ARGS:* =!"
)
set "_XINFA_WASM_READY="
where node >nul 2>nul
if !errorlevel! equ 0 if exist "%~dp0crates\xinfa\tooling\wasm-host.mjs" (
  node "%~dp0crates\xinfa\tooling\wasm-host.mjs" --engine-status --json >nul 2>nul
  if !errorlevel! equ 0 set "_XINFA_WASM_READY=1"
)
if defined _XINFA_WASM_READY (
  node "%~dp0crates\xinfa\tooling\wasm-host.mjs" !_XINFA_FORWARD_ARGS!
  exit /b !errorlevel!
)
echo shifu: checked-in Xinfa wasm is unavailable, stale, or lacks Node; falling back to the native trunk/cargo path 1>&2
if defined KUNGFU_TRUNK_BIN (
  if not exist "%KUNGFU_TRUNK_BIN%" (
    echo shifu: KUNGFU_TRUNK_BIN is not a file: %KUNGFU_TRUNK_BIN% 1>&2
    exit /b 127
  )
  "%KUNGFU_TRUNK_BIN%" xinfa --source-argv !_XINFA_FORWARD_ARGS!
  exit /b !errorlevel!
)
where cargo >nul 2>nul && (
  set "_XINFA_CACHE=%USERPROFILE%\.cache"
  if defined XDG_CACHE_HOME set "_XINFA_CACHE=%XDG_CACHE_HOME%"
  set "_XINFA_TGTKEY=%CD:\=_%"
  set "_XINFA_TGTKEY=!_XINFA_TGTKEY::=!"
  set "CARGO_TARGET_DIR=!_XINFA_CACHE!\kungfu\xinfa\cargo-target\!_XINFA_TGTKEY!"
  if defined XINFA_CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%XINFA_CARGO_TARGET_DIR%"
  cargo run --locked --quiet --manifest-path crates\Cargo.toml -p kungfu-trunk -- xinfa --source-argv !_XINFA_FORWARD_ARGS!
  exit /b !errorlevel!
)
if exist "%~dp0framework\core\dist\kungfu\kungfu-trunk.exe" (
  "%~dp0framework\core\dist\kungfu\kungfu-trunk.exe" xinfa --source-argv !_XINFA_FORWARD_ARGS!
  exit /b !errorlevel!
)
echo shifu: xinfa needs Cargo or the assembled kungfu-trunk; set KUNGFU_TRUNK_BIN to reuse an explicit prebuilt trunk 1>&2
exit /b 127

:xinfa
rem shifu-xinfa-entry: cache-independent
set "_XINFA_TASK=%~1"
if /i "%_XINFA_TASK%"=="xinfa:build" set "_XINFA_TASK=build"
if /i "%_XINFA_TASK%"=="xinfa:check" set "_XINFA_TASK=check"
if /i "%_XINFA_TASK%"=="xinfa:fix" set "_XINFA_TASK=fix"
if /i "%_XINFA_TASK%"=="xinfa:standalone" set "_XINFA_TASK=standalone"
shift
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0crates\xinfa\tooling\task.mjs" "%_XINFA_TASK%" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0crates\xinfa\tooling\task.mjs" "%_XINFA_TASK%" %*
  exit /b !errorlevel!
)
echo shifu: xinfa tasks need node -- install fnm or any system node 1>&2
exit /b 127

:docsreadonly
if /i not "%~1"=="docs:check:readonly" goto native
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0scripts\run-docs-readonly.mjs"
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0scripts\run-docs-readonly.mjs"
  exit /b !errorlevel!
)
echo shifu: docs:check:readonly needs node -- install fnm or any system node 1>&2
exit /b 127

:adrrelease
if /i not "%~1"=="adr:release:gate" goto native
set "_KFC_FORWARD_ARGS=%*"
set "_KFC_FORWARD_ARGS=%_KFC_FORWARD_ARGS:* =%"
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0scripts\adr-release-gate.mjs" %_KFC_FORWARD_ARGS%
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0scripts\adr-release-gate.mjs" %_KFC_FORWARD_ARGS%
  exit /b !errorlevel!
)
echo shifu: adr:release:gate needs node -- install fnm or any system node 1>&2
exit /b 127

rem -- Native launcher resolution ------------------------------------------------
:native
if "%SHIFU_NATIVE%"=="0" goto inscript

if defined SHIFU_BIN if exist "%SHIFU_BIN%" (
  "%SHIFU_BIN%" %*
  exit /b !errorlevel!
)

set "_KFC_VER="
for /f "tokens=1,2 delims== " %%a in (crates\shifu\Cargo.toml) do (
  if "%%a"=="version" if not defined _KFC_VER set "_KFC_VER=%%~b"
)
set "_KFC_CACHE=%USERPROFILE%\.cache"
if defined XDG_CACHE_HOME set "_KFC_CACHE=%XDG_CACHE_HOME%"
set "_KFC_BIN=%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%\shifu.exe"

rem Source freshness (dev machines): with cargo + git the cache slot is
rem content-addressed by the last commit touching the launcher source, so the
rem checkout's current code - not the last release, whose pin does not move
rem between releases - answers. Dirty launcher trees rebuild on every call
rem (cargo's own freshness check keeps repeats fast). Machines without cargo
rem keep the release-pinned path below unchanged.
where cargo >nul 2>nul || goto pinslot
where git >nul 2>nul || goto pinslot
if not defined _KFC_VER goto pinslot
set "_KFC_SRC="
rem rev-list instead of log --format: a percent format inside a for /f
rem backquote command gets percent-processed again by the child cmd, so git
rem receives a literal %h and fails; rev-list needs no format at all.
for /f "usebackq" %%s in (`git rev-list -1 --abbrev-commit HEAD -- crates/shifu crates/shifu-core crates/Cargo.toml crates/Cargo.lock 2^>nul`) do set "_KFC_SRC=%%s"
if not defined _KFC_SRC goto pinslot
set "_KFC_DIRTY="
for /f "usebackq delims=" %%s in (`git status --porcelain -- crates/shifu crates/shifu-core crates/Cargo.toml crates/Cargo.lock 2^>nul`) do set "_KFC_DIRTY=1"
if defined _KFC_DIRTY set "_KFC_SRC=%_KFC_SRC%-dirty"
set "_KFC_DEVDIR=%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%-%_KFC_SRC%"
set "_KFC_DEVBIN=%_KFC_DEVDIR%\shifu.exe"
if not defined _KFC_DIRTY if exist "%_KFC_DEVBIN%" (
  set "SHIFU_BIN=%_KFC_DEVBIN%"
  "%_KFC_DEVBIN%" %*
  exit /b !errorlevel!
)
rem Build with an out-of-repo target dir (keyed per checkout) so read-only
rem checkouts build too.
set "_KFC_TGTKEY=%CD:\=_%"
set "_KFC_TGTKEY=%_KFC_TGTKEY::=%"
set "_KFC_TGT=%_KFC_CACHE%\kungfu\shifu\cargo-target\%_KFC_TGTKEY%"
set "_KFC_SOURCE_BIN="
echo shifu: building launcher from source ^(cargo build --release^) 1>&2
set "CARGO_TARGET_DIR=%_KFC_TGT%"
cargo build --release --locked --manifest-path crates\Cargo.toml -p shifu 1>&2
set "_KFC_BUILD_ERROR=!errorlevel!"
if not "!_KFC_BUILD_ERROR!"=="0" (
  rem Windows scanners and concurrent first-use processes can briefly hold a
  rem just-linked executable. Retry once in an isolated target after a bounded
  rem delay; a second failure keeps the release-pinned fallback unchanged.
  set "_KFC_TGT=!_KFC_TGT!-retry-!RANDOM!-!RANDOM!"
  set "CARGO_TARGET_DIR=!_KFC_TGT!"
  echo shifu: source build failed once; retrying in an isolated target 1>&2
  ping -n 3 127.0.0.1 >nul 2>nul
  cargo build --release --locked --manifest-path crates\Cargo.toml -p shifu 1>&2
  set "_KFC_BUILD_ERROR=!errorlevel!"
)
if "!_KFC_BUILD_ERROR!"=="0" (
  set "CARGO_TARGET_DIR="
  rem The just-built target is always runnable. Publishing a warm cache slot
  rem is an optimization and must not decide whether the original task runs.
  set "_KFC_SOURCE_BIN=!_KFC_TGT!\release\shifu.exe"
  if not exist "%_KFC_DEVDIR%" mkdir "%_KFC_DEVDIR%" >nul 2>nul
  copy /y "%_KFC_TGT%\release\shifu.exe" "%_KFC_DEVBIN%" >nul && (
    set "_KFC_HEAD="
    set "_KFC_BRANCH=detached"
    set "_KFC_REPO="
    for /f "usebackq" %%s in (`git rev-parse HEAD 2^>nul`) do set "_KFC_HEAD=%%s"
    for /f "usebackq" %%s in (`git symbolic-ref --short HEAD 2^>nul`) do set "_KFC_BRANCH=%%s"
    for /f "usebackq tokens=1,*" %%a in (`git worktree list --porcelain 2^>nul`) do (
      if "%%a"=="worktree" if not defined _KFC_REPO set "_KFC_REPO=%%b"
    )
    set "_KFC_DIRTY_VALUE=false"
    if defined _KFC_DIRTY set "_KFC_DIRTY_VALUE=true"
    (
      echo KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'
      echo KUNGFU_ARTIFACT_PRODUCT='shifu'
      echo KUNGFU_ARTIFACT_SHA='!_KFC_HEAD!'
      echo KUNGFU_ARTIFACT_BRANCH='!_KFC_BRANCH!'
      echo KUNGFU_ARTIFACT_REPO='!_KFC_REPO!'
      echo KUNGFU_ARTIFACT_WORKTREE='!CD!'
      echo KUNGFU_ARTIFACT_BUILD_PATH='!_KFC_TGT!'
      echo KUNGFU_ARTIFACT_BUILT_AT='unknown'
      echo KUNGFU_ARTIFACT_DIRTY='!_KFC_DIRTY_VALUE!'
    ) > "%_KFC_DEVDIR%\meta.env.tmp"
    move /y "%_KFC_DEVDIR%\meta.env.tmp" "%_KFC_DEVDIR%\meta.env" >nul
    rem Source slots are catalog entries. The native catalog retires only
    rem proven ancestors after a successful promotion.
    set "_KFC_SOURCE_BIN=%_KFC_DEVBIN%"
  )
)
rem Dispatch only after the build/cache blocks have closed. This preserves the
rem batch argument vector and still runs the fresh target when cache publication
rem was denied by a scanner, lock, or transient filesystem error.
if not defined _KFC_SOURCE_BIN goto sourcebuildfailed
set "SHIFU_BIN=%_KFC_SOURCE_BIN%"
"%_KFC_SOURCE_BIN%" %*
exit /b !errorlevel!

:sourcebuildfailed
set "CARGO_TARGET_DIR="
set "_KFC_BUILD_ERROR="
echo shifu: source build failed; falling back to the release-pinned launcher 1>&2

:pinslot
if exist "%_KFC_BIN%" (
  "%_KFC_BIN%" %*
  exit /b !errorlevel!
)

rem Machines with both prerequisites keep the proven in-script path below;
rem fresh machines (or SHIFU_NATIVE=1) acquire the native launcher.
if "%SHIFU_NATIVE%"=="1" goto acquire
where fnm >nul 2>nul || goto acquire
where uv >nul 2>nul || goto acquire
goto inscript

:acquire
set "_KFC_BASE=https://github.com/kungfu-systems/kungfu/releases/download"
if defined SHIFU_DIST_MIRROR set "_KFC_BASE=%SHIFU_DIST_MIRROR%"
set "_KFC_URL=%_KFC_BASE%/shifu-v%_KFC_VER%/shifu-windows-x64.exe"
where curl >nul 2>nul && (
  echo shifu: fetching prebuilt launcher %_KFC_VER% ^(windows-x64^) 1>&2
  if not exist "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" mkdir "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" >nul 2>nul
  curl -fsSL --retry 2 --connect-timeout 20 -o "%_KFC_BIN%.tmp" "%_KFC_URL%" && (
    move /y "%_KFC_BIN%.tmp" "%_KFC_BIN%" >nul
    "!_KFC_BIN!" %*
    exit /b !errorlevel!
  )
  del "%_KFC_BIN%.tmp" >nul 2>nul
)
set "_KFC_ACQUIRE_KEY=%CD:\=_%"
set "_KFC_ACQUIRE_KEY=%_KFC_ACQUIRE_KEY::=%"
set "_KFC_ACQUIRE_PREV_CARGO_TARGET_DIR=%CARGO_TARGET_DIR%"
where cargo >nul 2>nul && (
  echo shifu: building native launcher from source ^(cargo build --release^) 1>&2
  set "_KFC_ACQUIRE_TGT=%_KFC_CACHE%\kungfu\shifu\cargo-target\acquire-%_KFC_ACQUIRE_KEY%"
  set "CARGO_TARGET_DIR=!_KFC_ACQUIRE_TGT!"
  cargo build --release --locked --manifest-path crates\Cargo.toml -p shifu 1>&2 && (
    if not exist "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" mkdir "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" >nul 2>nul
    copy /y "!_KFC_ACQUIRE_TGT!\release\shifu.exe" "%_KFC_BIN%" >nul && (
      if defined _KFC_ACQUIRE_PREV_CARGO_TARGET_DIR (
        set "CARGO_TARGET_DIR=!_KFC_ACQUIRE_PREV_CARGO_TARGET_DIR!"
      ) else (
        set "CARGO_TARGET_DIR="
      )
      "!_KFC_BIN!" %*
      exit /b !errorlevel!
    )
  )
  if defined _KFC_ACQUIRE_PREV_CARGO_TARGET_DIR (
    set "CARGO_TARGET_DIR=!_KFC_ACQUIRE_PREV_CARGO_TARGET_DIR!"
  ) else (
    set "CARGO_TARGET_DIR="
  )
)
echo shifu: native launcher unavailable; falling back to the in-script bootstrap 1>&2
goto inscript

:inscript
rem In-script fallback versions of the launcher-owned flags (the native
rem launcher normally answers these before we get here).
if "%~1"=="" (
  echo shifu - the kungfu development/build launcher ^(pinned-toolchain entrypoint^)
  echo.
  echo   shifu ^<task^> [args...]     run any pnpm task under the pinned toolchain
  echo   shifu build ^| rebuild      bootstrap build ^(rebuild clears generated outputs^)
  echo   shifu cache ...            inspect the versioned cache contract and schemas
  echo   shifu gate ...             inspect and plan registered project gates
  echo   shifu proxy ^| config ...   manage local mirror/cache config
  echo   shifu --version            launcher version; shifu help for pnpm's own help
  echo.
  echo Common tasks: sync, build, check, fix, verify, dist, app  ^(docs: AGENTS.md^)
  exit /b 2
)
if "%~1"=="--version" goto scriptversion
if "%~1"=="-v" goto scriptversion
if "%~1"=="-V" goto scriptversion
goto richcheck

:scriptversion
echo shifu %_KFC_VER% ^(script^)
exit /b 0

:richcheck
rem Native dispatch owns automatic cache application when available. Mirror the
rem same once-only behavior here for the in-script fallback. A partial pair is
rem intentionally forwarded so the Shifu resolver fails closed.
if "%SHIFU_CACHE_ACTIVE%"=="1" goto richdispatch
if "%SHIFU_CACHE_BYPASS%"=="source-acceptance" goto richdispatch
if not defined SHIFU_CACHE_PROFILE_REF if not defined SHIFU_CACHE_PROFILE_DIGEST goto richdispatch
if /i "%~1"=="cache"       goto richdispatch
if /i "%~1"=="docs"        goto richdispatch
if /i "%~1"=="gate" if /i not "%~2"=="run" goto richdispatch
rem shifu-cache-entry: gate-run-outer-apply
if /i "%~1"=="proxy"       goto richdispatch
if /i "%~1"=="config"      goto richdispatch
if /i "%~1"=="clone"       goto richdispatch
if /i "%~1"=="self-update" goto richdispatch
if /i "%~1"=="self-version" goto richdispatch
if /i "%~1"=="promote"     goto richdispatch
if /i "%~1"=="builds"      goto richdispatch
call "%~f0" cache apply -- shifu.cmd %*
exit /b !errorlevel!

:richdispatch
rem -- Delegate rich subcommands to L2 node (no pnpm, no uv). Prefer fnm node, else system node. --
if /i "%~1"=="proxy"  goto delegate
if /i "%~1"=="config" goto delegate
if /i "%~1"=="docs"   goto delegate
if /i "%~1"=="gate"   goto delegate
goto bootstrap

:delegate
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec -- node "%~dp0shifu.mjs" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0shifu.mjs" %*
  exit /b !errorlevel!
)
echo shifu: rich subcommand needs node -- install fnm ^(winget install Schniz.fnm^) or any system node 1>&2
exit /b 127

:bootstrap
where fnm >nul 2>nul || (
  echo shifu: install fnm first ^(node-side prereq^) -- winget install Schniz.fnm ^(or https://github.com/Schniz/fnm^) 1>&2
  exit /b 127
)
where uv >nul 2>nul || (
  echo shifu: install uv first ^(python-side prereq^) -- winget install astral-sh.uv ^(or https://docs.astral.sh/uv/^) 1>&2
  exit /b 127
)

rem Idempotent: ensure the node pinned by .node-version is installed
fnm install >nul 2>nul

rem Under the pinned node, run the packageManager-pinned pnpm via corepack.
rem NOTE: use corepack.cmd (not bare "corepack"): fnm exec spawns the program directly
rem without applying PATHEXT, so bare "corepack" is not found on Windows (only corepack.cmd is).
fnm exec -- corepack.cmd pnpm %*
exit /b !errorlevel!
